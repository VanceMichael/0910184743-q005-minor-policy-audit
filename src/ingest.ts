import {newTokenPayload, signToken, type Role} from "./auth.js";
import {randomKeySecret, sha256Hex, hmacSha256Hex, stableStringify} from "./cryptoUtil.js";
import {mapPgError, withTransaction, type Pool, type PoolClient} from "./db.js";
import {conflict, notFound, unprocessable} from "./errors.js";
import {
  DEFAULT_POLICIES,
  evaluateContentPolicy,
  restrictionForOutcome,
  type AgeBand,
  type DecisionOutcome,
  type PolicyRules,
} from "./policy.js";
import type {
  AppealRow,
  AuthKeyRow,
  DecisionRow,
  EventRow,
  PolicyRow,
  ProjectionRow,
} from "./rows.js";
import type {
  AgeEvidencePayload,
  AppealOutcome,
  AppealPayload,
  ContentRiskPayload,
  GuardianshipPayload,
  ParsedEvent,
} from "./validation.js";

const GENESIS_HASH = "GENESIS";

/** 租户首次出现时同事务供应：租户行、默认策略 v1/v2、初始签名密钥 k1。 */
export async function ensureTenant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("INSERT INTO tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [tenantId]);
  for (const seed of DEFAULT_POLICIES) {
    await client.query(
      `INSERT INTO policies (tenant_id, version, name, rules)
       VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, version) DO NOTHING`,
      [tenantId, seed.version, seed.name, JSON.stringify(seed.rules)],
    );
  }
  await client.query(
    `INSERT INTO auth_keys (tenant_id, key_id, secret, status)
     SELECT $1, 'k1', $2, 'active'
     WHERE NOT EXISTS (SELECT 1 FROM auth_keys WHERE tenant_id = $1)
     ON CONFLICT (tenant_id, key_id) DO NOTHING`,
    [tenantId, randomKeySecret()],
  );
}

async function getActiveKey(client: PoolClient, tenantId: string): Promise<AuthKeyRow> {
  const result = await client.query<AuthKeyRow>(
    "SELECT * FROM auth_keys WHERE tenant_id = $1 AND status = 'active'",
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`租户 ${tenantId} 缺少 active 签名密钥`);
  return row;
}

export type AppendDecisionInput = Readonly<{
  tenantId: string;
  accountId: string;
  eventId: string;
  sourceSeq: bigint;
  decisionSeq: bigint;
  kind: string;
  outcome: string;
  applied: boolean;
  ageBand: string | null;
  guardianshipStatus: string | null;
  policyVersion: number;
  riskLevel: string | null;
  reasonCode: string;
  payloadHash: string;
  prevHash: string;
}>;

/**
 * 追加不可变审计决定。decision_hash = HMAC(active_key, 规范化决定)，
 * prev_hash 串联同一账号的上一条决定，形成按账号的防篡改链。
 * key_id 记录的是“决定当时”的密钥，轮换后历史行保持原 key_id。
 */
async function appendDecision(
  client: PoolClient,
  key: AuthKeyRow,
  input: AppendDecisionInput,
): Promise<DecisionRow> {
  const createdAt = new Date();
  const canonical = stableStringify({
    tenant_id: input.tenantId,
    account_id: input.accountId,
    event_id: input.eventId,
    source_seq: input.sourceSeq.toString(),
    decision_seq: input.decisionSeq.toString(),
    kind: input.kind,
    outcome: input.outcome,
    applied: input.applied,
    age_band: input.ageBand,
    guardianship_status: input.guardianshipStatus,
    policy_version: input.policyVersion,
    risk_level: input.riskLevel,
    reason_code: input.reasonCode,
    key_id: key.key_id,
    payload_hash: input.payloadHash,
    prev_hash: input.prevHash,
    created_at: createdAt.toISOString(),
  });
  const decisionHash = hmacSha256Hex(key.secret, canonical);
  const result = await client.query<DecisionRow>(
    `INSERT INTO decisions (
       tenant_id, account_id, event_id, source_seq, decision_seq, kind, outcome, applied,
       age_band, guardianship_status, policy_version, risk_level, reason_code,
       key_id, payload_hash, prev_hash, decision_hash, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      input.tenantId, input.accountId, input.eventId, input.sourceSeq.toString(),
      input.decisionSeq.toString(), input.kind, input.outcome, input.applied,
      input.ageBand, input.guardianshipStatus, input.policyVersion, input.riskLevel,
      input.reasonCode, key.key_id, input.payloadHash, input.prevHash, decisionHash, createdAt,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("决定写入失败");
  return row;
}

export type IngestResult = Readonly<{
  status: "applied" | "stale" | "duplicate";
  event: EventRow;
  decision: DecisionRow;
  appeal: AppealRow | null;
  resolutionDecision: DecisionRow | null;
}>;

async function loadDecisionForEvent(
  client: PoolClient,
  tenantId: string,
  eventId: string,
  kind: string,
): Promise<DecisionRow> {
  const result = await client.query<DecisionRow>(
    "SELECT * FROM decisions WHERE tenant_id = $1 AND event_id = $2 AND kind = $3",
    [tenantId, eventId, kind],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`事件 ${eventId} 缺少对应决定，数据不一致`);
  return row;
}

async function loadAppealBundle(
  client: PoolClient,
  tenantId: string,
  eventId: string,
): Promise<{appeal: AppealRow | null; resolution: DecisionRow | null}> {
  const appealResult = await client.query<AppealRow>(
    "SELECT * FROM appeals WHERE tenant_id = $1 AND event_id = $2",
    [tenantId, eventId],
  );
  const appeal = appealResult.rows[0] ?? null;
  if (!appeal || appeal.resolution_decision_id === null) return {appeal, resolution: null};
  const resolutionResult = await client.query<DecisionRow>(
    "SELECT * FROM decisions WHERE id = $1",
    [appeal.resolution_decision_id],
  );
  return {appeal, resolution: resolutionResult.rows[0] ?? null};
}

/**
 * 摄入单个事件。幂等落库、单调版本检查、策略决策、不可变审计全部在一个事务内完成。
 * 并发同一账号通过投影行 SELECT ... FOR UPDATE 串行化；旧序号事件记录为 stale，
 * 可查询但绝不回退投影状态。
 */
export async function ingestEvent(pool: Pool, parsed: ParsedEvent): Promise<IngestResult> {
  try {
    return await withTransaction(pool, async (client) => {
      await ensureTenant(client, parsed.tenantId);
      const payloadHash = sha256Hex(stableStringify(parsed.payload));

      // 1) 锁定（或创建）该账号唯一的当前投影——同事务内串行化并发摄入
      await client.query(
        `INSERT INTO account_projection (tenant_id, account_id)
         VALUES ($1, $2) ON CONFLICT (tenant_id, account_id) DO NOTHING`,
        [parsed.tenantId, parsed.accountId],
      );
      const projectionResult = await client.query<ProjectionRow>(
        "SELECT * FROM account_projection WHERE tenant_id = $1 AND account_id = $2 FOR UPDATE",
        [parsed.tenantId, parsed.accountId],
      );
      const projection = projectionResult.rows[0];
      if (!projection) throw new Error("投影创建失败");

      // 2) 单调序号检查：只有更大的 source_seq 才并入投影（投影行已锁定，判定是串行的）
      const lastApplied = BigInt(projection.last_applied_seq);
      const applied = BigInt(parsed.sourceSeq) > lastApplied;

      // 3) 幂等落库：同 event_id 的并发插入在数据库层等待先行者提交。
      //    事件不可变，applied/stale 在插入时一次定稿，绝不事后改写。
      const insertResult = await client.query<EventRow>(
        `INSERT INTO account_events
           (tenant_id, account_id, event_id, source_seq, kind, payload, payload_hash, occurred_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id, event_id) DO NOTHING
         RETURNING *`,
        [
          parsed.tenantId, parsed.accountId, parsed.eventId, parsed.sourceSeq.toString(),
          parsed.kind, JSON.stringify(parsed.payload), payloadHash, parsed.occurredAt,
          applied ? "applied" : "stale",
        ],
      );

      const inserted = insertResult.rows[0];
      if (!inserted) {
        // 重放：同一 event_id 已落库。负载必须完全一致，否则是幂等键被复用
        const existingResult = await client.query<EventRow>(
          "SELECT * FROM account_events WHERE tenant_id = $1 AND event_id = $2",
          [parsed.tenantId, parsed.eventId],
        );
        const existing = existingResult.rows[0];
        if (!existing) throw new Error("幂等冲突后读取不到原事件");
        if (
          existing.account_id !== parsed.accountId ||
          BigInt(existing.source_seq) !== BigInt(parsed.sourceSeq) ||
          existing.kind !== parsed.kind ||
          existing.payload_hash !== payloadHash
        ) {
          throw conflict("event_id_conflict", "event_id 已被不同负载的事件占用");
        }
        const decision = await loadDecisionForEvent(client, parsed.tenantId, parsed.eventId, existing.kind);
        const bundle = existing.kind === "appeal"
          ? await loadAppealBundle(client, parsed.tenantId, parsed.eventId)
          : {appeal: null, resolution: null};
        return {
          status: "duplicate" as const,
          event: existing,
          decision,
          appeal: bundle.appeal,
          resolutionDecision: bundle.resolution,
        };
      }

      // 4) 单调策略版本：投影版本只升不降，迟到事件不会撤销更严格的新限制
      const latestPolicy = await client.query<{max: number | null}>(
        "SELECT max(version) AS max FROM policies WHERE tenant_id = $1",
        [parsed.tenantId],
      );
      const latestVersion = latestPolicy.rows[0]?.max ?? 1;
      if (parsed.policyVersion !== null) {
        const exists = await client.query(
          "SELECT 1 FROM policies WHERE tenant_id = $1 AND version = $2",
          [parsed.tenantId, parsed.policyVersion],
        );
        if (exists.rowCount !== 1) {
          throw unprocessable("unknown_policy_version", `策略版本 ${parsed.policyVersion} 不存在`);
        }
      }
      const effectiveVersion = Math.max(
        projection.policy_version,
        parsed.policyVersion ?? latestVersion,
      );
      const policyResult = await client.query<PolicyRow>(
        "SELECT * FROM policies WHERE tenant_id = $1 AND version = $2",
        [parsed.tenantId, effectiveVersion],
      );
      const policyRow = policyResult.rows[0];
      if (!policyRow) throw new Error(`策略版本 ${effectiveVersion} 缺失`);
      const rules = policyRow.rules as PolicyRules;

      // 5) 计算事件生效后的事实（stale 事件不改变事实）
      const agePayload = parsed.kind === "age_evidence" ? (parsed.payload as AgeEvidencePayload) : null;
      const guardPayload = parsed.kind === "guardianship" ? (parsed.payload as GuardianshipPayload) : null;
      const riskPayload = parsed.kind === "content_risk" ? (parsed.payload as ContentRiskPayload) : null;
      const appealPayload = parsed.kind === "appeal" ? (parsed.payload as AppealPayload) : null;

      const factAgeBand = applied && agePayload ? agePayload.age_band : projection.age_band;
      const factGuardianship = applied && guardPayload ? guardPayload.status : projection.guardianship_status;

      // 6) 策略决策
      let outcome: string;
      let reasonCode: string;
      let riskLevel: string | null = null;
      if (riskPayload) {
        const verdict = evaluateContentPolicy(rules, {
          ageBand: (factAgeBand ?? null) as AgeBand | null,
          guardianshipStatus: factGuardianship,
          riskLevel: riskPayload.risk_level,
        });
        outcome = verdict.outcome;
        reasonCode = verdict.reasonCode;
        riskLevel = riskPayload.risk_level;
      } else if (parsed.kind === "age_evidence") {
        outcome = "record";
        reasonCode = "age_evidence_recorded";
      } else if (parsed.kind === "guardianship") {
        outcome = "record";
        reasonCode = "guardianship_recorded";
      } else {
        outcome = "record";
        reasonCode = "appeal_opened";
      }

      // 7) 不可变审计决定（哈希链接在投影锁保护下推进）
      const key = await getActiveKey(client, parsed.tenantId);
      const decisionSeq = BigInt(projection.decision_count) + 1n;
      const decision = await appendDecision(client, key, {
        tenantId: parsed.tenantId,
        accountId: parsed.accountId,
        eventId: parsed.eventId,
        sourceSeq: BigInt(parsed.sourceSeq),
        decisionSeq,
        kind: parsed.kind,
        outcome,
        applied,
        ageBand: factAgeBand,
        guardianshipStatus: factGuardianship,
        policyVersion: effectiveVersion,
        riskLevel,
        reasonCode,
        payloadHash,
        prevHash: projection.last_decision_hash || GENESIS_HASH,
      });

      // 8) 申诉事件：开立申诉并引用目标决定（目标必须是本租户本账号的内容决定）
      let appeal: AppealRow | null = null;
      let resolutionDecision: DecisionRow | null = null;
      if (appealPayload) {
        const targetResult = await client.query<DecisionRow>(
          "SELECT * FROM decisions WHERE id = $1 AND tenant_id = $2",
          [appealPayload.target_decision_id.toString(), parsed.tenantId],
        );
        const target = targetResult.rows[0];
        if (!target) {
          throw unprocessable("appeal_target_not_found", `决定 ${appealPayload.target_decision_id} 不存在`);
        }
        if (target.account_id !== parsed.accountId) {
          throw unprocessable("appeal_account_mismatch", "申诉目标决定不属于该账号");
        }
        if (target.kind !== "content_risk") {
          throw unprocessable("appeal_target_not_appealable", "只有内容风险决定可以被申诉");
        }
        const appealResult = await client.query<AppealRow>(
          `INSERT INTO appeals (tenant_id, appeal_id, account_id, event_id, target_decision_id, status, reason)
           VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING *`,
          [
            parsed.tenantId, appealPayload.appeal_id, parsed.accountId,
            parsed.eventId, target.id, appealPayload.reason ?? null,
          ],
        );
        appeal = appealResult.rows[0] ?? null;
      }

      // 9) 更新唯一当前投影：stale 事件只推进审计链簿记，不回退任何领域状态
      const restriction = applied && riskPayload
        ? restrictionForOutcome(outcome as DecisionOutcome)
        : projection.restriction_level;
      const restrictionDecisionId = applied && riskPayload
        ? decision.id
        : projection.restriction_decision_id;
      await client.query(
        `UPDATE account_projection SET
           last_applied_seq = $3,
           projection_revision = $4,
           decision_count = $5,
           age_band = $6,
           age_attestation_id = $7,
           guardianship_status = $8,
           guardian_id = $9,
           policy_version = $10,
           restriction_level = $11,
           restriction_decision_id = $12,
           last_decision_id = $13,
           last_decision_hash = $14,
           updated_at = now()
         WHERE tenant_id = $1 AND account_id = $2`,
        [
          parsed.tenantId, parsed.accountId,
          (applied ? BigInt(parsed.sourceSeq) : lastApplied).toString(),
          (BigInt(projection.projection_revision) + (applied ? 1n : 0n)).toString(),
          decisionSeq.toString(),
          factAgeBand,
          applied && agePayload ? agePayload.attestation_id : projection.age_attestation_id,
          factGuardianship,
          applied && guardPayload ? guardPayload.guardian_id : projection.guardian_id,
          applied ? effectiveVersion : projection.policy_version,
          restriction,
          restrictionDecisionId,
          decision.id,
          decision.decision_hash,
        ],
      );

      // 10) 申诉事件自带 outcome 时在同一事务内完成解决
      if (appeal && appealPayload?.outcome) {
        const resolved = await resolveAppealInTransaction(client, {
          tenantId: parsed.tenantId,
          appealId: appealPayload.appeal_id,
          outcome: appealPayload.outcome,
          resolver: "event",
          note: null,
        });
        appeal = resolved.appeal;
        resolutionDecision = resolved.resolution;
      }

      return {
        status: applied ? ("applied" as const) : ("stale" as const),
        event: inserted,
        decision,
        appeal,
        resolutionDecision,
      };
    });
  } catch (err) {
    const mapped = mapPgError(err);
    if (mapped) throw mapped;
    throw err;
  }
}

export type ResolveAppealInput = Readonly<{
  tenantId: string;
  appealId: string;
  outcome: AppealOutcome;
  resolver: string;
  note: string | null;
}>;

/**
 * 解决申诉：在同一事务内追加 appeal_resolution 决定、更新申诉状态、
 * 仅在当前限制确实源自被推翻决定时前向解除限制（绝不回退到旧序号状态）。
 * 申诉结果通过 target_decision_id / resolution_decision_id 双向引用。
 */
export async function resolveAppealInTransaction(
  client: PoolClient,
  input: ResolveAppealInput,
): Promise<{appeal: AppealRow; resolution: DecisionRow}> {
  // 锁顺序与摄入管线一致（投影 → 申诉），避免与“申诉事件自带 outcome”路径互相死锁
  const peek = await client.query<AppealRow>(
    "SELECT * FROM appeals WHERE tenant_id = $1 AND appeal_id = $2",
    [input.tenantId, input.appealId],
  );
  const peeked = peek.rows[0];
  if (!peeked) throw notFound("appeal_not_found", `申诉 ${input.appealId} 不存在`);

  const projectionResult = await client.query<ProjectionRow>(
    "SELECT * FROM account_projection WHERE tenant_id = $1 AND account_id = $2 FOR UPDATE",
    [input.tenantId, peeked.account_id],
  );
  const projection = projectionResult.rows[0];
  if (!projection) throw new Error("申诉账号缺少投影");

  const appealResult = await client.query<AppealRow>(
    "SELECT * FROM appeals WHERE tenant_id = $1 AND appeal_id = $2 FOR UPDATE",
    [input.tenantId, input.appealId],
  );
  const appeal = appealResult.rows[0];
  if (!appeal) throw notFound("appeal_not_found", `申诉 ${input.appealId} 不存在`);
  if (appeal.status !== "pending") {
    throw conflict("appeal_already_resolved", `申诉 ${input.appealId} 已是 ${appeal.status} 状态`);
  }

  const targetResult = await client.query<DecisionRow>(
    "SELECT * FROM decisions WHERE id = $1",
    [appeal.target_decision_id],
  );
  const target = targetResult.rows[0];
  if (!target) throw new Error("申诉目标决定缺失");

  const appealEvent = await client.query<EventRow>(
    "SELECT * FROM account_events WHERE tenant_id = $1 AND event_id = $2",
    [input.tenantId, appeal.event_id],
  );
  const sourceSeq = BigInt(appealEvent.rows[0]?.source_seq ?? projection.last_applied_seq);

  // 只有当前限制确实来自被推翻的决定时才解除；否则该限制已被更新的事件取代
  const liftsRestriction =
    input.outcome === "overturn" &&
    projection.restriction_decision_id !== null &&
    projection.restriction_decision_id === target.id;
  const reasonCode =
    input.outcome === "overturn"
      ? liftsRestriction
        ? "appeal_overturned_restriction_lifted"
        : "appeal_overturned_superseded"
      : "appeal_upheld";

  const key = await getActiveKey(client, input.tenantId);
  const decisionSeq = BigInt(projection.decision_count) + 1n;
  const resolution = await appendDecision(client, key, {
    tenantId: input.tenantId,
    accountId: appeal.account_id,
    eventId: appeal.event_id,
    sourceSeq,
    decisionSeq,
    kind: "appeal_resolution",
    outcome: input.outcome,
    applied: true,
    ageBand: projection.age_band,
    guardianshipStatus: projection.guardianship_status,
    policyVersion: projection.policy_version,
    riskLevel: target.risk_level,
    reasonCode,
    payloadHash: sha256Hex(
      stableStringify({appeal_id: input.appealId, outcome: input.outcome, note: input.note, target_decision_id: target.id}),
    ),
    prevHash: projection.last_decision_hash || GENESIS_HASH,
  });

  const updatedAppeal = await client.query<AppealRow>(
    `UPDATE appeals SET
       status = $3, resolved_at = now(), resolution_decision_id = $4, resolver = $5, resolution_note = $6
     WHERE tenant_id = $1 AND appeal_id = $2
     RETURNING *`,
    [
      input.tenantId, input.appealId,
      input.outcome === "overturn" ? "overturned" : "upheld",
      resolution.id, input.resolver, input.note,
    ],
  );

  await client.query(
    `UPDATE account_projection SET
       projection_revision = $3,
       decision_count = $4,
       restriction_level = $5,
       restriction_decision_id = $6,
       last_decision_id = $7,
       last_decision_hash = $8,
       updated_at = now()
     WHERE tenant_id = $1 AND account_id = $2`,
    [
      input.tenantId, appeal.account_id,
      (BigInt(projection.projection_revision) + (liftsRestriction ? 1n : 0n)).toString(),
      decisionSeq.toString(),
      liftsRestriction ? 0 : projection.restriction_level,
      liftsRestriction ? resolution.id : projection.restriction_decision_id,
      resolution.id,
      resolution.decision_hash,
    ],
  );

  const updated = updatedAppeal.rows[0];
  if (!updated) throw new Error("申诉状态更新失败");
  return {appeal: updated, resolution};
}

/** 端点用：独立事务解决申诉。 */
export async function resolveAppeal(
  pool: Pool,
  input: ResolveAppealInput,
): Promise<{appeal: AppealRow; resolution: DecisionRow}> {
  try {
    return await withTransaction(pool, (client) => resolveAppealInTransaction(client, input));
  } catch (err) {
    const mapped = mapPgError(err);
    if (mapped) throw mapped;
    throw err;
  }
}

/** 密钥轮换：同事务内退旧换新；retired 密钥继续用于验签与历史决定核验。 */
export async function rotateKey(
  pool: Pool,
  tenantId: string,
): Promise<{keyId: string}> {
  return withTransaction(pool, async (client) => {
    await ensureTenant(client, tenantId);
    const current = await getActiveKey(client, tenantId);
    const countResult = await client.query<{count: string}>(
      "SELECT count(*) AS count FROM auth_keys WHERE tenant_id = $1",
      [tenantId],
    );
    const next = Number(countResult.rows[0]?.count ?? "1") + 1;
    const keyId = `k${next}`;
    await client.query(
      "UPDATE auth_keys SET status = 'retired', retired_at = now() WHERE tenant_id = $1 AND key_id = $2",
      [tenantId, current.key_id],
    );
    await client.query(
      "INSERT INTO auth_keys (tenant_id, key_id, secret, status) VALUES ($1, $2, $3, 'active')",
      [tenantId, keyId, randomKeySecret()],
    );
    return {keyId};
  });
}

/** 签发令牌：校验引导密钥后，用租户当前 active 密钥签名。 */
export async function mintToken(
  pool: Pool,
  input: {tenantId: string; subject: string; role: Role; ttlSeconds: number},
): Promise<{token: string; keyId: string; expiresAt: number}> {
  return withTransaction(pool, async (client) => {
    await ensureTenant(client, input.tenantId);
    const key = await getActiveKey(client, input.tenantId);
    const payload = newTokenPayload(input.tenantId, input.subject, input.role, input.ttlSeconds);
    return {
      token: signToken(key.secret, key.key_id, payload),
      keyId: key.key_id,
      expiresAt: payload.exp,
    };
  });
}
