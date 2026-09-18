/** 数据库行类型（snake_case，与迁移文件列名一致）。 */

export type EventRow = Readonly<{
  id: string;
  tenant_id: string;
  account_id: string;
  event_id: string;
  source_seq: string;
  kind: string;
  payload: unknown;
  payload_hash: string;
  occurred_at: Date | null;
  received_at: Date;
  status: "applied" | "stale";
}>;

export type DecisionRow = Readonly<{
  id: string;
  tenant_id: string;
  account_id: string;
  event_id: string;
  source_seq: string;
  decision_seq: string;
  kind: string;
  outcome: string;
  applied: boolean;
  age_band: string | null;
  guardianship_status: string | null;
  policy_version: number;
  risk_level: string | null;
  reason_code: string;
  key_id: string;
  payload_hash: string;
  prev_hash: string;
  decision_hash: string;
  created_at: Date;
}>;

export type ProjectionRow = Readonly<{
  tenant_id: string;
  account_id: string;
  last_applied_seq: string;
  projection_revision: string;
  decision_count: string;
  age_band: string | null;
  age_attestation_id: string | null;
  guardianship_status: string;
  guardian_id: string | null;
  policy_version: number;
  restriction_level: number;
  restriction_decision_id: string | null;
  last_decision_id: string | null;
  last_decision_hash: string;
  updated_at: Date;
}>;

export type AppealRow = Readonly<{
  tenant_id: string;
  appeal_id: string;
  account_id: string;
  event_id: string;
  target_decision_id: string;
  status: "pending" | "overturned" | "upheld";
  reason: string | null;
  opened_at: Date;
  resolved_at: Date | null;
  resolution_decision_id: string | null;
  resolver: string | null;
  resolution_note: string | null;
}>;

export type AuthKeyRow = Readonly<{
  tenant_id: string;
  key_id: string;
  secret: string;
  status: "active" | "retired";
  created_at: Date;
  retired_at: Date | null;
}>;

export type PolicyRow = Readonly<{
  tenant_id: string;
  version: number;
  name: string;
  rules: unknown;
  created_at: Date;
}>;
