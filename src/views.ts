import type {Role} from "./domain/types.js";
import type {AppealRow, DecisionRow, EventRow, ProjectionRow} from "./store.js";

/**
 * 字段级最小可见性：
 *  - guardian：决定结果、年龄段与理由；看不到其他监护人明细、风险类目与内部 key_id；
 *  - reviewer：复核所需的全部脱敏证据与快照，含 key_id；
 *  - auditor：只读全量审计字段（含签名 key_id、受理标志与时间戳），用于核验历史。
 */

export function eventView(row: EventRow, role: Role, subject: string | null) {
  const base = {
    event_id: row.event_id,
    tenant_id: row.tenant_id,
    account_id: row.account_id,
    source_seq: Number(row.source_seq),
    kind: row.event_kind,
    applied: row.applied,
    received_at: row.received_at.toISOString(),
  };
  if (role === "guardian") {
    // 监护人仅可见年龄段证据与属于本人的授权事件内容
    let payload: unknown;
    if (row.event_kind === "age_evidence") payload = row.payload;
    if (row.event_kind === "guardian_authorization" &&
        (row.payload as {guardian_id?: string}).guardian_id === subject) {
      payload = row.payload;
    }
    return {...base, ...(payload !== undefined ? {payload} : {})};
  }
  return {
    ...base,
    payload: row.payload,
    note: row.note,
    signing_key_id: row.signing_key_id,
  };
}

export function decisionView(row: DecisionRow, role: Role, subject: string | null) {
  const base = {
    id: Number(row.id),
    content_event_id: row.content_event_id,
    source_seq: Number(row.source_seq),
    decision: row.decision,
    policy_version: row.policy_version,
    age_band: row.age_band,
    age_band_known: row.age_band_known,
    rationale: row.rationale,
    applied: row.applied,
    created_at: row.created_at.toISOString(),
  };
  if (role === "guardian") {
    // 监护人只见风险等级，不见风险类目等内部细节
    const risk = (row.risk_snapshot as {risk?: string}).risk;
    return {...base, risk};
  }
  if (role === "reviewer") {
    return {
      ...base,
      risk_snapshot: row.risk_snapshot,
      guardian_snapshot: redactGuardianScopes(row.guardian_snapshot, subject),
      signing_key_id: row.signing_key_id,
    };
  }
  // auditor：完整快照
  return {
    ...base,
    risk_snapshot: row.risk_snapshot,
    guardian_snapshot: row.guardian_snapshot,
    signing_key_id: row.signing_key_id,
  };
}

function redactGuardianScopes(snapshot: DecisionRow["guardian_snapshot"], subject: string | null) {
  const guardians: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(snapshot?.guardians ?? {})) {
    if (id === subject) {
      guardians[id] = entry;
    } else {
      const {scope, ...rest} = entry as Record<string, unknown>;
      guardians[id] = rest;
    }
  }
  return {guardians};
}

export function appealView(row: AppealRow, role: Role) {
  const base = {
    id: Number(row.id),
    appeal_event_id: row.appeal_event_id,
    source_seq: Number(row.source_seq),
    target_decision_id: Number(row.target_decision_id),
    target_content_event_id: row.target_content_event_id,
    result: row.result,
    original_decision: row.original_decision,
    reviewed_decision: row.reviewed_decision,
    policy_version: row.policy_version,
    reason: row.reason,
    applied: row.applied,
    created_at: row.created_at.toISOString(),
  };
  if (role === "guardian") {
    return base;
  }
  return {...base, signing_key_id: row.signing_key_id};
}

export function projectionView(row: ProjectionRow | null, role: Role, subject: string | null) {
  if (!row) {
    return {revision: 0, age_band: null, age_known: false, latest_decision: null};
  }
  const base = {
    revision: Number(row.revision),
    age_band: row.age_band,
    age_known: row.age_known,
    latest_content_event_id: row.latest_content_event_id,
    latest_decision: row.latest_decision,
    updated_at: row.updated_at.toISOString(),
  };
  if (role === "guardian") {
    const guardians = row.guardian_state?.guardians ?? {};
    const own = subject ? guardians[subject] : undefined;
    return {
      ...base,
      active_guardian_count: Object.values(guardians).filter((g) => g.status === "active").length,
      ...(own ? {own_guardian_status: own.status} : {}),
    };
  }
  return {...base, guardian_state: row.guardian_state};
}
