import type {PoolClient, QueryResultRow} from "pg";
import type {
  AgeBand,
  Decision,
  Envelope,
  GuardianEntry,
  ProjectionState,
} from "./domain/types.js";
import {initialProjection} from "./domain/types.js";

export type EventRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  account_id: string;
  event_id: string;
  source_seq: string;
  event_kind: string;
  payload: Record<string, unknown>;
  signing_key_id: string;
  applied: boolean;
  note: string | null;
  decision_id: string | null;
  appeal_id: string | null;
  received_at: Date;
};

export type DecisionRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  account_id: string;
  content_event_id: string;
  source_seq: string;
  decision: Decision;
  policy_version: string;
  age_band: AgeBand | null;
  age_band_known: boolean;
  guardian_snapshot: {guardians: Record<string, GuardianEntry>};
  risk_snapshot: Record<string, unknown>;
  rationale: string;
  signing_key_id: string;
  applied: boolean;
  created_at: Date;
};

export type AppealRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  account_id: string;
  appeal_event_id: string;
  source_seq: string;
  target_decision_id: string;
  target_content_event_id: string;
  result: "overturned" | "maintained";
  original_decision: Decision;
  reviewed_decision: Decision;
  policy_version: string;
  reason: string;
  signing_key_id: string;
  applied: boolean;
  created_at: Date;
};

export type ProjectionRow = QueryResultRow & {
  tenant_id: string;
  account_id: string;
  revision: string;
  age_band: AgeBand | null;
  age_known: boolean;
  age_band_seq: string | null;
  guardian_state: {guardians: Record<string, GuardianEntry>};
  latest_content_event_id: string | null;
  latest_decision: Decision | null;
  updated_at: Date;
};

export async function insertEvent(
  client: PoolClient,
  event: Envelope,
  signingKeyId: string,
  applied: boolean,
  note: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO account_events
       (tenant_id, account_id, event_id, source_seq, event_kind, payload, signing_key_id, applied, note)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
    [
      event.tenantId,
      event.accountId,
      event.eventId,
      event.sourceSeq,
      event.kind,
      JSON.stringify(event.payload),
      signingKeyId,
      applied,
      note,
    ],
  );
}

export async function findEventById(client: PoolClient, eventId: string): Promise<EventRow | null> {
  const result = await client.query<EventRow>("SELECT * FROM account_events WHERE event_id = $1", [eventId]);
  return result.rows[0] ?? null;
}

/** 幂等重放时，取回事件在首次事务中挂接的决定/申诉审计行 */
export async function loadLinkedResults(
  client: PoolClient,
  decisionId: string | null,
  appealId: string | null,
): Promise<{decision: DecisionRow | null; appeal: AppealRow | null}> {
  let decision: DecisionRow | null = null;
  let appeal: AppealRow | null = null;
  if (decisionId !== null) {
    const r = await client.query<DecisionRow>("SELECT * FROM content_decisions WHERE id = $1", [decisionId]);
    decision = r.rows[0] ?? null;
  }
  if (appealId !== null) {
    const r = await client.query<AppealRow>("SELECT * FROM appeal_outcomes WHERE id = $1", [appealId]);
    appeal = r.rows[0] ?? null;
  }
  return {decision, appeal};
}

export async function lockProjection(client: PoolClient, tenantId: string, accountId: string): Promise<ProjectionRow | null> {
  const result = await client.query<ProjectionRow>(
    "SELECT * FROM account_projection WHERE tenant_id = $1 AND account_id = $2 FOR UPDATE",
    [tenantId, accountId],
  );
  return result.rows[0] ?? null;
}

export function rowToProjection(row: ProjectionRow | null): ProjectionState {
  if (!row) return {...initialProjection};
  return {
    revision: Number(row.revision),
    ageBand: row.age_band,
    ageKnown: row.age_known,
    ageBandSeq: row.age_band_seq === null ? null : Number(row.age_band_seq),
    guardians: row.guardian_state?.guardians ?? {},
    latestContentEventId: row.latest_content_event_id,
    latestDecision: row.latest_decision,
  };
}

export async function upsertProjection(
  client: PoolClient,
  tenantId: string,
  accountId: string,
  state: ProjectionState,
): Promise<void> {
  await client.query(
    `INSERT INTO account_projection
       (tenant_id, account_id, revision, age_band, age_known, age_band_seq,
        guardian_state, latest_content_event_id, latest_decision, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,now())
     ON CONFLICT (tenant_id, account_id) DO UPDATE SET
       revision = EXCLUDED.revision,
       age_band = EXCLUDED.age_band,
       age_known = EXCLUDED.age_known,
       age_band_seq = EXCLUDED.age_band_seq,
       guardian_state = EXCLUDED.guardian_state,
       latest_content_event_id = EXCLUDED.latest_content_event_id,
       latest_decision = EXCLUDED.latest_decision,
       updated_at = now()`,
    [
      tenantId,
      accountId,
      state.revision,
      state.ageBand,
      state.ageKnown,
      state.ageBandSeq,
      JSON.stringify({guardians: state.guardians}),
      state.latestContentEventId,
      state.latestDecision,
    ],
  );
}

export async function insertDecision(
  client: PoolClient,
  fields: {
    event: Envelope;
    decision: Decision;
    policyVersion: string;
    state: ProjectionState;
    riskSnapshot: unknown;
    rationale: string;
    signingKeyId: string;
  },
): Promise<DecisionRow> {
  const {event, state} = fields;
  const result = await client.query<DecisionRow>(
    `INSERT INTO content_decisions
       (tenant_id, account_id, content_event_id, source_seq, decision, policy_version,
        age_band, age_band_known, guardian_snapshot, risk_snapshot, rationale, signing_key_id, applied)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,TRUE)
     RETURNING *`,
    [
      event.tenantId,
      event.accountId,
      event.eventId,
      event.sourceSeq,
      fields.decision,
      fields.policyVersion,
      state.ageBand,
      state.ageKnown,
      JSON.stringify({guardians: state.guardians}),
      JSON.stringify(fields.riskSnapshot),
      fields.rationale,
      fields.signingKeyId,
    ],
  );
  return result.rows[0]!;
}

export async function findDecisionByContentEvent(
  client: PoolClient,
  tenantId: string,
  accountId: string,
  contentEventId: string,
): Promise<DecisionRow | null> {
  const result = await client.query<DecisionRow>(
    "SELECT * FROM content_decisions WHERE tenant_id = $1 AND account_id = $2 AND content_event_id = $3",
    [tenantId, accountId, contentEventId],
  );
  return result.rows[0] ?? null;
}

export async function insertAppeal(
  client: PoolClient,
  fields: {
    event: Envelope;
    target: DecisionRow;
    result: "overturned" | "maintained";
    reviewedDecision: Decision;
    reviewPolicyVersion: string;
    reason: string;
    signingKeyId: string;
  },
): Promise<AppealRow> {
  const result = await client.query<AppealRow>(
    `INSERT INTO appeal_outcomes
       (tenant_id, account_id, appeal_event_id, source_seq, target_decision_id,
        target_content_event_id, result, original_decision, reviewed_decision,
        policy_version, reason, signing_key_id, applied)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE)
     RETURNING *`,
    [
      fields.event.tenantId,
      fields.event.accountId,
      fields.event.eventId,
      fields.event.sourceSeq,
      Number(fields.target.id),
      fields.target.content_event_id,
      fields.result,
      fields.target.decision,
      fields.reviewedDecision,
      fields.reviewPolicyVersion,
      fields.reason,
      fields.signingKeyId,
    ],
  );
  return result.rows[0]!;
}

// ---------- 读模型 ----------

export async function getProjection(
  client: PoolClient,
  tenantId: string,
  accountId: string,
): Promise<ProjectionRow | null> {
  const result = await client.query<ProjectionRow>(
    "SELECT * FROM account_projection WHERE tenant_id = $1 AND account_id = $2",
    [tenantId, accountId],
  );
  return result.rows[0] ?? null;
}

export async function listEvents(
  client: PoolClient,
  tenantId: string,
  accountId: string,
): Promise<EventRow[]> {
  const result = await client.query<EventRow>(
    "SELECT * FROM account_events WHERE tenant_id = $1 AND account_id = $2 ORDER BY source_seq ASC, id ASC",
    [tenantId, accountId],
  );
  return result.rows;
}

export async function getEventBySeq(
  client: PoolClient,
  tenantId: string,
  accountId: string,
  seq: number,
): Promise<EventRow | null> {
  const result = await client.query<EventRow>(
    "SELECT * FROM account_events WHERE tenant_id = $1 AND account_id = $2 AND source_seq = $3",
    [tenantId, accountId, seq],
  );
  return result.rows[0] ?? null;
}

export async function listDecisions(
  client: PoolClient,
  tenantId: string,
  accountId: string,
): Promise<DecisionRow[]> {
  const result = await client.query<DecisionRow>(
    "SELECT * FROM content_decisions WHERE tenant_id = $1 AND account_id = $2 ORDER BY source_seq ASC",
    [tenantId, accountId],
  );
  return result.rows;
}

export async function listAppeals(
  client: PoolClient,
  tenantId: string,
  accountId: string,
): Promise<AppealRow[]> {
  const result = await client.query<AppealRow>(
    "SELECT * FROM appeal_outcomes WHERE tenant_id = $1 AND account_id = $2 ORDER BY source_seq ASC",
    [tenantId, accountId],
  );
  return result.rows;
}

export async function getDecisionByEvent(
  client: PoolClient,
  tenantId: string,
  accountId: string,
  contentEventId: string,
): Promise<DecisionRow | null> {
  return findDecisionByContentEvent(client, tenantId, accountId, contentEventId);
}

export async function getAppealByEvent(
  client: PoolClient,
  tenantId: string,
  accountId: string,
  appealEventId: string,
): Promise<AppealRow | null> {
  const result = await client.query<AppealRow>(
    "SELECT * FROM appeal_outcomes WHERE tenant_id = $1 AND account_id = $2 AND appeal_event_id = $3",
    [tenantId, accountId, appealEventId],
  );
  return result.rows[0] ?? null;
}
