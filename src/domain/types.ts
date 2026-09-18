/** 与 contracts/policy.json 对齐的领域枚举 */

export const AGE_BANDS = ["under_13", "13_to_15", "16_to_17"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const EVENT_KINDS = ["age_evidence", "guardian_authorization", "content_risk", "appeal"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const DECISIONS = ["allow", "limit", "block", "review"] as const;
export type Decision = (typeof DECISIONS)[number];

export const ROLES = ["guardian", "reviewer", "auditor"] as const;
export type Role = (typeof ROLES)[number];

export type RiskLevel = "low" | "medium" | "high";
export type GuardianStatus = "active" | "revoked";
export type AppealResult = "overturned" | "maintained";

/** 年龄证明（脱敏）：只保留年龄段与证据强度，不含真实生日 */
export type AgeEvidencePayload = Readonly<{
  age_band: AgeBand;
  confidence?: "low" | "high";
}>;

/** 监护授权：guardian_id 为脱敏标识，可授予或撤销 */
export type GuardianAuthorizationPayload = Readonly<{
  guardian_id: string;
  action: "grant" | "revoke";
  scope?: string;
}>;

/** 内容风险：action 是被判定的内容动作（如 view/post/message） */
export type ContentRiskPayload = Readonly<{
  content_id: string;
  action: string;
  risk: RiskLevel;
  categories?: readonly string[];
}>;

/** 申诉：针对某条历史内容事件，给出复核结论请求 */
export type AppealPayload = Readonly<{
  target_content_event_id: string;
  claim: "false_positive" | "new_evidence" | "procedural";
  requested_decision?: Decision;
  note?: string;
}>;

export type EventPayload =
  | AgeEvidencePayload
  | GuardianAuthorizationPayload
  | ContentRiskPayload
  | AppealPayload;

export type Envelope = Readonly<{
  eventId: string;
  tenantId: string;
  accountId: string;
  sourceSeq: number;
  kind: EventKind;
  payload: EventPayload;
}>;

/** 单个监护人在投影中的最新状态 */
export type GuardianEntry = Readonly<{
  status: GuardianStatus;
  scope: string | null;
  seq: number;
}>;

/** 账号当前投影：由有序事件 fold 得到 */
export type ProjectionState = Readonly<{
  revision: number;
  ageBand: AgeBand | null;
  ageKnown: boolean;
  ageBandSeq: number | null;
  guardians: Readonly<Record<string, GuardianEntry>>;
  latestContentEventId: string | null;
  latestDecision: Decision | null;
}>;

export type PolicyContext = Readonly<{
  policyVersion: string;
  ageBand: AgeBand | null;
  ageKnown: boolean;
  guardianActive: boolean;
}>;

export type PolicyVerdict = Readonly<{
  decision: Decision;
  rationale: string;
}>;

export type GuardianSnapshotEntry = GuardianEntry;

export const initialProjection: ProjectionState = {
  revision: 0,
  ageBand: null,
  ageKnown: false,
  ageBandSeq: null,
  guardians: {},
  latestContentEventId: null,
  latestDecision: null,
};
