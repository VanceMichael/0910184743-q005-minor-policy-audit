import type {PoolClient} from "pg";
import {lockAccount, type Db} from "./db.js";
import {
  findEventById,
  insertAppeal,
  insertDecision,
  insertEvent,
  loadLinkedResults,
  lockProjection,
  rowToProjection,
  upsertProjection,
  type AppealRow,
  type DecisionRow,
  type EventRow,
} from "./store.js";
import type {AppealPayload, ContentRiskPayload, Envelope, ProjectionState} from "./domain/types.js";
import {applyEvent, guardianActive} from "./domain/projection.js";
import {CURRENT_POLICY_VERSION, decide, reviewAppeal} from "./domain/policy.js";
import {ValidationError} from "./domain/validation.js";

export class ConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** 幂等命中时返回的既有受理结果 */
export type IngestResult = Readonly<{
  idempotent: boolean;
  applied: boolean;
  status: "applied" | "duplicate" | "late";
  sourceSeq: number;
  projectionRevision: number;
  decision?: {id: number; decision: string; policyVersion: string};
  appeal?: {id: number; result: string; targetDecisionId: number};
  note: string | null;
}>;

function eventToResult(row: EventRow, revision: number, linked?: {decision?: DecisionRow | null; appeal?: AppealRow | null}): IngestResult {
  return {
    idempotent: true,
    applied: row.applied,
    status: row.applied ? "duplicate" : "late",
    sourceSeq: Number(row.source_seq),
    projectionRevision: revision,
    note: row.note,
    ...(linked?.decision
      ? {decision: {id: Number(linked.decision.id), decision: linked.decision.decision, policyVersion: linked.decision.policy_version}}
      : {}),
    ...(linked?.appeal
      ? {appeal: {id: Number(linked.appeal.id), result: linked.appeal.result, targetDecisionId: Number(linked.appeal.target_decision_id)}}
      : {}),
  };
}

/**
 * 在同一事务内完成：账号加锁 -> 幂等检查 -> 单调版本检查 -> 策略决策 -> 不可变审计 -> 投影推进。
 * 旧序号事件（迟到/乱序）落库但 applied=false，可查询，绝不回退投影。
 */
export async function ingestEvent(
  db: Db,
  event: Envelope,
  signingKeyId: string,
  faultInject: boolean,
): Promise<IngestResult> {
  return db.withTransaction(async (client) => {
    // 1) 账号级串行：并发处理同一账号时，只允许一个当前投影写入者
    await lockAccount(client, event.tenantId, event.accountId);

    // 2) 幂等：相同 event_id 直接返回首次受理结果
    const existing = await findEventById(client, event.eventId);
    const projectionRow = await lockProjection(client, event.tenantId, event.accountId);
    const current = rowToProjection(projectionRow);

    if (existing) {
      if (existing.tenant_id !== event.tenantId || existing.account_id !== event.accountId) {
        throw new ConflictError("event_id 已属于其他租户或账号");
      }
      const linked = await loadLinkedResults(client, existing.decision_id, existing.appeal_id);
      return eventToResult(existing, current.revision, linked);
    }

    // 3) 单调版本检查：序号必须严格大于当前投影 revision 才允许推进状态
    if (event.sourceSeq <= current.revision) {
      // 迟到/乱序事件：事实保留（唯一约束保证不覆盖），但不回退状态
      await insertEvent(client, event, signingKeyId, false,
        `乱序/迟到事件：source_seq=${event.sourceSeq} 不大于当前 revision=${current.revision}，仅留存不推进状态`);
      return {
        idempotent: false,
        applied: false,
        status: "late",
        sourceSeq: event.sourceSeq,
        projectionRevision: current.revision,
        note: "事件序号落后于当前投影，已留存但未应用",
      };
    }

    // 序号可以跳跃（来源端可能丢事件），但同序号已被另一 event_id 占用时由唯一键兜底报 409
    let nextState: ProjectionState = current;
    let decisionRow: DecisionRow | null = null;
    let appealRow: AppealRow | null = null;

    if (event.kind === "content_risk") {
      const risk = event.payload as ContentRiskPayload;
      const verdict = decide(CURRENT_POLICY_VERSION, {
        policyVersion: CURRENT_POLICY_VERSION,
        ageBand: current.ageBand,
        ageKnown: current.ageKnown,
        guardianActive: guardianActive(current),
      }, risk.risk);
      // 4) 不可变决定：先写审计并拿到 id，事件再挂接
      decisionRow = await insertDecision(client, {
        event,
        decision: verdict.decision,
        policyVersion: CURRENT_POLICY_VERSION,
        state: current,
        riskSnapshot: risk,
        rationale: verdict.rationale,
        signingKeyId,
      });
      nextState = applyEvent(current, event, verdict.decision);
    } else if (event.kind === "appeal") {
      const payload = event.payload as AppealPayload;
      // 申诉必须引用账号内真实存在的内容决定
      const target = await findTargetDecision(client, event, payload.target_content_event_id);
      const review = reviewAppeal({
        target,
        appeal: payload,
        currentAgeBand: current.ageBand,
        currentAgeKnown: current.ageKnown,
        currentGuardianActive: guardianActive(current),
      });
      appealRow = await insertAppeal(client, {
        event,
        target,
        result: review.result,
        reviewedDecision: review.reviewedDecision,
        reviewPolicyVersion: review.reviewPolicyVersion,
        reason: review.reason,
        signingKeyId,
      });
      // 申诉不改变事实投影，revision 仍前进到该序号（投影标记“已见”该序号）
      nextState = applyEvent(current, event);
    } else {
      nextState = applyEvent(current, event);
    }

    // 5) 故障注入：自动化验收制造事务失败 —— 此刻之前的全部写入随回滚消失
    if (faultInject) {
      throw new Error("故障注入：事务回滚（x-fault: abort）");
    }

    // 6) 事件落库并挂接审计产物；投影推进（revision 单调，触发器禁止回退）
    await insertEventWithLinks(client, event, signingKeyId, decisionRow, appealRow);
    await upsertProjection(client, event.tenantId, event.accountId, nextState);

    return {
      idempotent: false,
      applied: true,
      status: "applied",
      sourceSeq: event.sourceSeq,
      projectionRevision: nextState.revision,
      ...(decisionRow
        ? {decision: {id: Number(decisionRow.id), decision: decisionRow.decision, policyVersion: decisionRow.policy_version}}
        : {}),
      ...(appealRow
        ? {appeal: {id: Number(appealRow.id), result: appealRow.result, targetDecisionId: Number(appealRow.target_decision_id)}}
        : {}),
      note: null,
    };
  });
}

async function findTargetDecision(
  client: PoolClient,
  event: Envelope,
  targetContentEventId: string,
): Promise<DecisionRow> {
  const result = await client.query<DecisionRow>(
    "SELECT * FROM content_decisions WHERE tenant_id = $1 AND account_id = $2 AND content_event_id = $3",
    [event.tenantId, event.accountId, targetContentEventId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ValidationError(`申诉目标内容事件 ${targetContentEventId} 在本账号不存在或尚未裁决`);
  }
  if (Number(row.source_seq) >= event.sourceSeq) {
    throw new ConflictError("申诉序号必须晚于被申诉决定的序号");
  }
  return row;
}

async function insertEventWithLinks(
  client: PoolClient,
  event: Envelope,
  signingKeyId: string,
  decisionRow: DecisionRow | null,
  appealRow: AppealRow | null,
): Promise<void> {
  await client.query(
    `INSERT INTO account_events
       (tenant_id, account_id, event_id, source_seq, event_kind, payload,
        signing_key_id, applied, decision_id, appeal_id, note)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,TRUE,$8,$9,NULL)`,
    [
      event.tenantId,
      event.accountId,
      event.eventId,
      event.sourceSeq,
      event.kind,
      JSON.stringify(event.payload),
      signingKeyId,
      decisionRow ? Number(decisionRow.id) : null,
      appealRow ? Number(appealRow.id) : null,
    ],
  );
}
