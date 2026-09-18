import {mapPgError, withTransaction, type Pool} from "./db.js";
import {conflict} from "./errors.js";
import {isPolicyRules} from "./policy.js";
import type {AppealRow, DecisionRow, EventRow, PolicyRow, ProjectionRow} from "./rows.js";
import {badRequest} from "./errors.js";

export async function getProjection(
  pool: Pool,
  tenantId: string,
  accountId: string,
): Promise<ProjectionRow | null> {
  const result = await pool.query<ProjectionRow>(
    "SELECT * FROM account_projection WHERE tenant_id = $1 AND account_id = $2",
    [tenantId, accountId],
  );
  return result.rows[0] ?? null;
}

export async function getDecisionById(
  pool: Pool,
  tenantId: string,
  decisionId: number,
): Promise<DecisionRow | null> {
  const result = await pool.query<DecisionRow>(
    "SELECT * FROM decisions WHERE tenant_id = $1 AND id = $2",
    [tenantId, decisionId],
  );
  return result.rows[0] ?? null;
}

export async function getAppealById(
  pool: Pool,
  tenantId: string,
  appealId: string,
): Promise<{appeal: AppealRow; resolution: DecisionRow | null} | null> {
  const appealResult = await pool.query<AppealRow>(
    "SELECT * FROM appeals WHERE tenant_id = $1 AND appeal_id = $2",
    [tenantId, appealId],
  );
  const appeal = appealResult.rows[0];
  if (!appeal) return null;
  if (appeal.resolution_decision_id === null) return {appeal, resolution: null};
  const resolutionResult = await pool.query<DecisionRow>(
    "SELECT * FROM decisions WHERE id = $1",
    [appeal.resolution_decision_id],
  );
  return {appeal, resolution: resolutionResult.rows[0] ?? null};
}

export type TimelineEntry = Readonly<{
  event: EventRow;
  decision: DecisionRow | null;
  appeal: AppealRow | null;
  resolution: DecisionRow | null;
}>;

/**
 * 账号时间线：事件按 source_seq 稳定排序，关联其决定与申诉。
 * 全部来自持久化表，数据库重启恢复后结果逐字节一致。
 */
export async function getTimeline(
  pool: Pool,
  tenantId: string,
  accountId: string,
): Promise<TimelineEntry[] | null> {
  const projection = await getProjection(pool, tenantId, accountId);
  if (!projection) return null;

  const events = await pool.query<EventRow>(
    `SELECT * FROM account_events
     WHERE tenant_id = $1 AND account_id = $2
     ORDER BY source_seq ASC, id ASC`,
    [tenantId, accountId],
  );
  const decisions = await pool.query<DecisionRow>(
    "SELECT * FROM decisions WHERE tenant_id = $1 AND account_id = $2 ORDER BY decision_seq ASC",
    [tenantId, accountId],
  );
  const appeals = await pool.query<AppealRow>(
    "SELECT * FROM appeals WHERE tenant_id = $1 AND account_id = $2 ORDER BY opened_at ASC",
    [tenantId, accountId],
  );

  const primaryByEvent = new Map<string, DecisionRow>();
  const resolutionById = new Map<string, DecisionRow>();
  for (const decision of decisions.rows) {
    if (decision.kind === "appeal_resolution") {
      resolutionById.set(decision.id, decision);
    } else {
      primaryByEvent.set(decision.event_id, decision);
    }
  }
  const appealByEvent = new Map<string, AppealRow>();
  for (const appeal of appeals.rows) {
    appealByEvent.set(appeal.event_id, appeal);
  }

  return events.rows.map((event) => {
    const appeal = appealByEvent.get(event.event_id) ?? null;
    const resolution = appeal?.resolution_decision_id
      ? resolutionById.get(appeal.resolution_decision_id) ?? null
      : null;
    return {
      event,
      decision: primaryByEvent.get(event.event_id) ?? null,
      appeal,
      resolution,
    };
  });
}

export async function listPolicies(pool: Pool, tenantId: string): Promise<PolicyRow[]> {
  const result = await pool.query<PolicyRow>(
    "SELECT * FROM policies WHERE tenant_id = $1 ORDER BY version ASC",
    [tenantId],
  );
  return result.rows;
}

/** 发布新策略版本：版本号必须严格大于当前最大版本（单调递增检查）。 */
export async function publishPolicy(
  pool: Pool,
  tenantId: string,
  input: {version: number; name: string; rules: unknown},
): Promise<PolicyRow> {
  if (!isPolicyRules(input.rules)) {
    throw badRequest("invalid_policy_rules", "rules.matrix 必须是 风险×年龄段 的处置矩阵");
  }
  try {
    return await withTransaction(pool, async (client) => {
      const current = await client.query<{max: number | null}>(
        "SELECT max(version) AS max FROM policies WHERE tenant_id = $1",
        [tenantId],
      );
      const max = current.rows[0]?.max ?? 0;
      if (input.version <= max) {
        throw conflict(
          "policy_version_not_monotonic",
          `策略版本必须大于当前版本 ${max}，收到 ${input.version}`,
        );
      }
      const inserted = await client.query<PolicyRow>(
        "INSERT INTO policies (tenant_id, version, name, rules) VALUES ($1,$2,$3,$4) RETURNING *",
        [tenantId, input.version, input.name, JSON.stringify(input.rules)],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("策略写入失败");
      return row;
    });
  } catch (err) {
    const mapped = mapPgError(err);
    if (mapped) throw mapped;
    throw err;
  }
}
