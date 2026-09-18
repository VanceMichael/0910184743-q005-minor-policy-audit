import type {Role} from "./auth.js";
import type {AppealRow, DecisionRow, EventRow, ProjectionRow} from "./rows.js";

/**
 * 角色字段裁剪：监护人 / 平台复核员 / 审计员看到不同字段。
 * key_id 与哈希链只对审计员开放；历史决定在密钥轮换后仍显示原 key_id。
 */

const num = (value: string | null): number | null => (value === null ? null : Number(value));
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = source[field];
  return out;
}

const DECISION_FIELDS: Record<Role, readonly string[]> = {
  guardian: ["id", "account_id", "kind", "outcome", "reason_code", "created_at"],
  reviewer: [
    "id", "account_id", "event_id", "source_seq", "kind", "outcome", "applied",
    "age_band", "guardianship_status", "policy_version", "risk_level", "reason_code", "created_at",
  ],
  auditor: [
    "id", "tenant_id", "account_id", "event_id", "source_seq", "decision_seq", "kind", "outcome",
    "applied", "age_band", "guardianship_status", "policy_version", "risk_level", "reason_code",
    "key_id", "payload_hash", "prev_hash", "decision_hash", "created_at",
  ],
};

export function decisionView(row: DecisionRow, role: Role): Record<string, unknown> {
  const full: Record<string, unknown> = {
    id: Number(row.id),
    tenant_id: row.tenant_id,
    account_id: row.account_id,
    event_id: row.event_id,
    source_seq: Number(row.source_seq),
    decision_seq: Number(row.decision_seq),
    kind: row.kind,
    outcome: row.outcome,
    applied: row.applied,
    age_band: row.age_band,
    guardianship_status: row.guardianship_status,
    policy_version: row.policy_version,
    risk_level: row.risk_level,
    reason_code: row.reason_code,
    key_id: row.key_id,
    payload_hash: row.payload_hash,
    prev_hash: row.prev_hash,
    decision_hash: row.decision_hash,
    created_at: row.created_at.toISOString(),
  };
  return pick(full, DECISION_FIELDS[role]);
}

const PROJECTION_FIELDS: Record<Role, readonly string[]> = {
  guardian: ["account_id", "restriction_level", "guardianship_status", "updated_at"],
  reviewer: [
    "account_id", "age_band", "guardianship_status", "policy_version", "restriction_level",
    "last_applied_seq", "projection_revision", "restriction_decision_id", "last_decision_id", "updated_at",
  ],
  auditor: [
    "tenant_id", "account_id", "age_band", "age_attestation_id", "guardianship_status", "guardian_id",
    "policy_version", "restriction_level", "last_applied_seq", "projection_revision", "decision_count",
    "restriction_decision_id", "last_decision_id", "last_decision_hash", "updated_at",
  ],
};

export function projectionView(row: ProjectionRow, role: Role): Record<string, unknown> {
  const full: Record<string, unknown> = {
    tenant_id: row.tenant_id,
    account_id: row.account_id,
    age_band: row.age_band,
    age_attestation_id: row.age_attestation_id,
    guardianship_status: row.guardianship_status,
    guardian_id: row.guardian_id,
    policy_version: row.policy_version,
    restriction_level: row.restriction_level,
    last_applied_seq: Number(row.last_applied_seq),
    projection_revision: Number(row.projection_revision),
    decision_count: Number(row.decision_count),
    restriction_decision_id: num(row.restriction_decision_id),
    last_decision_id: num(row.last_decision_id),
    last_decision_hash: row.last_decision_hash,
    updated_at: row.updated_at.toISOString(),
  };
  return pick(full, PROJECTION_FIELDS[role]);
}

const EVENT_FIELDS: Record<Role, readonly string[]> = {
  guardian: ["source_seq", "kind", "status", "received_at"],
  reviewer: ["event_id", "source_seq", "kind", "status", "occurred_at", "received_at", "payload"],
  auditor: [
    "id", "tenant_id", "account_id", "event_id", "source_seq", "kind", "status",
    "occurred_at", "received_at", "payload", "payload_hash",
  ],
};

export function eventView(row: EventRow, role: Role): Record<string, unknown> {
  const full: Record<string, unknown> = {
    id: Number(row.id),
    tenant_id: row.tenant_id,
    account_id: row.account_id,
    event_id: row.event_id,
    source_seq: Number(row.source_seq),
    kind: row.kind,
    status: row.status,
    occurred_at: iso(row.occurred_at),
    received_at: row.received_at.toISOString(),
    payload: row.payload,
    payload_hash: row.payload_hash,
  };
  return pick(full, EVENT_FIELDS[role]);
}

const APPEAL_FIELDS: Record<Role, readonly string[]> = {
  guardian: [
    "appeal_id", "account_id", "status", "reason", "opened_at", "resolved_at",
    "overturned_decision_id", "upheld_decision_id",
  ],
  reviewer: [
    "appeal_id", "account_id", "event_id", "status", "reason", "opened_at", "resolved_at",
    "target_decision_id", "resolution_decision_id", "resolver",
    "overturned_decision_id", "upheld_decision_id",
  ],
  auditor: [
    "tenant_id", "appeal_id", "account_id", "event_id", "status", "reason", "opened_at", "resolved_at",
    "target_decision_id", "resolution_decision_id", "resolver", "resolution_note",
    "overturned_decision_id", "upheld_decision_id",
  ],
};

/** 申诉视图：overturned_decision_id / upheld_decision_id 引用它实际推翻或维持的决定。 */
export function appealView(row: AppealRow, role: Role): Record<string, unknown> {
  const targetId = Number(row.target_decision_id);
  const full: Record<string, unknown> = {
    tenant_id: row.tenant_id,
    appeal_id: row.appeal_id,
    account_id: row.account_id,
    event_id: row.event_id,
    status: row.status,
    reason: row.reason,
    opened_at: row.opened_at.toISOString(),
    resolved_at: iso(row.resolved_at),
    target_decision_id: targetId,
    resolution_decision_id: num(row.resolution_decision_id),
    resolver: row.resolver,
    resolution_note: row.resolution_note,
    overturned_decision_id: row.status === "overturned" ? targetId : null,
    upheld_decision_id: row.status === "upheld" ? targetId : null,
  };
  return pick(full, APPEAL_FIELDS[role]);
}
