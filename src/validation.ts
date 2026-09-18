import {badRequest} from "./errors.js";
import {isAgeBand, isRiskLevel, type AgeBand, type RiskLevel} from "./policy.js";

export const EVENT_KINDS = ["age_evidence", "guardianship", "content_risk", "appeal"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const APPEAL_OUTCOMES = ["overturn", "uphold"] as const;
export type AppealOutcome = (typeof APPEAL_OUTCOMES)[number];

export type AgeEvidencePayload = Readonly<{
  age_band: AgeBand;
  attestation_id: string;
  method?: string;
}>;

export type GuardianshipPayload = Readonly<{
  guardian_id: string;
  relation: "parent" | "legal_guardian" | "custodian";
  status: "active" | "revoked" | "expired";
}>;

export type ContentRiskPayload = Readonly<{
  content_id: string;
  risk_level: RiskLevel;
  categories?: string[];
  action?: string;
}>;

export type AppealPayload = Readonly<{
  appeal_id: string;
  target_decision_id: number;
  reason?: string;
  outcome?: AppealOutcome;
}>;

export type EventPayload = AgeEvidencePayload | GuardianshipPayload | ContentRiskPayload | AppealPayload;

export type ParsedEvent = Readonly<{
  tenantId: string;
  accountId: string;
  eventId: string;
  sourceSeq: number;
  kind: EventKind;
  policyVersion: number | null;
  occurredAt: Date | null;
  payload: EventPayload;
}>;

const MAX_ID_LENGTH = 128;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw badRequest("invalid_payload", `${what} 必须是 JSON 对象`);
  return value;
}

function requireString(obj: Record<string, unknown>, field: string, maxLength = MAX_ID_LENGTH): string {
  const value = obj[field];
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw badRequest("invalid_payload", `字段 ${field} 必须是 1..${maxLength} 字符的非空字符串`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, field: string, maxLength = 1024): string | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw badRequest("invalid_payload", `字段 ${field} 必须是长度不超过 ${maxLength} 的字符串`);
  }
  return value;
}

function requirePositiveInt(obj: Record<string, unknown>, field: string): number {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw badRequest("invalid_payload", `字段 ${field} 必须是正整数`);
  }
  return value;
}

function optionalPositiveInt(obj: Record<string, unknown>, field: string): number | null {
  const value = obj[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw badRequest("invalid_payload", `字段 ${field} 必须是正整数`);
  }
  return value;
}

function optionalStringArray(obj: Record<string, unknown>, field: string): string[] | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw badRequest("invalid_payload", `字段 ${field} 必须是字符串数组`);
  }
  return value as string[];
}

function optionalDate(obj: Record<string, unknown>, field: string): Date | null {
  const value = obj[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest("invalid_payload", `字段 ${field} 必须是 ISO 时间字符串`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw badRequest("invalid_payload", `字段 ${field} 不是合法时间: ${value}`);
  }
  return date;
}

function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);
}

function isAppealOutcome(value: unknown): value is AppealOutcome {
  return typeof value === "string" && (APPEAL_OUTCOMES as readonly string[]).includes(value);
}

function parsePayload(kind: EventKind, raw: unknown): EventPayload {
  const payload = requireObject(raw, "payload");
  switch (kind) {
    case "age_evidence": {
      const ageBand = payload["age_band"];
      if (!isAgeBand(ageBand)) {
        throw badRequest("invalid_payload", "age_band 必须是 under_13 | 13_to_15 | 16_to_17 | adult");
      }
      return {
        age_band: ageBand,
        attestation_id: requireString(payload, "attestation_id"),
        method: optionalString(payload, "method", 64),
      };
    }
    case "guardianship": {
      const relation = payload["relation"];
      if (relation !== "parent" && relation !== "legal_guardian" && relation !== "custodian") {
        throw badRequest("invalid_payload", "relation 必须是 parent | legal_guardian | custodian");
      }
      const status = payload["status"];
      if (status !== "active" && status !== "revoked" && status !== "expired") {
        throw badRequest("invalid_payload", "status 必须是 active | revoked | expired");
      }
      return {guardian_id: requireString(payload, "guardian_id"), relation, status};
    }
    case "content_risk": {
      const riskLevel = payload["risk_level"];
      if (!isRiskLevel(riskLevel)) {
        throw badRequest("invalid_payload", "risk_level 必须是 low | medium | high | critical");
      }
      return {
        content_id: requireString(payload, "content_id"),
        risk_level: riskLevel,
        categories: optionalStringArray(payload, "categories"),
        action: optionalString(payload, "action", 64),
      };
    }
    case "appeal": {
      const outcome = payload["outcome"];
      if (outcome !== undefined && outcome !== null && !isAppealOutcome(outcome)) {
        throw badRequest("invalid_payload", "outcome 必须是 overturn | uphold");
      }
      return {
        appeal_id: requireString(payload, "appeal_id"),
        target_decision_id: requirePositiveInt(payload, "target_decision_id"),
        reason: optionalString(payload, "reason"),
        outcome: isAppealOutcome(outcome) ? outcome : undefined,
      };
    }
  }
}

/** 校验摄入事件信封与负载；任何不合法都在进入事务前以 400 拒绝。 */
export function validateEventEnvelope(body: unknown): ParsedEvent {
  const obj = requireObject(body, "请求体");
  const kind = obj["kind"];
  if (!isEventKind(kind)) {
    throw badRequest("invalid_payload", `kind 必须是 ${EVENT_KINDS.join(" | ")}`);
  }
  return {
    tenantId: requireString(obj, "tenant_id"),
    accountId: requireString(obj, "account_id"),
    eventId: requireString(obj, "event_id"),
    sourceSeq: requirePositiveInt(obj, "source_seq"),
    kind,
    policyVersion: optionalPositiveInt(obj, "policy_version"),
    occurredAt: optionalDate(obj, "occurred_at"),
    payload: parsePayload(kind, obj["payload"]),
  };
}

export type TokenRequest = Readonly<{tenantId: string; subject: string; role: string; secret: string}>;

export function validateTokenRequest(body: unknown): TokenRequest {
  const obj = requireObject(body, "请求体");
  return {
    tenantId: requireString(obj, "tenant_id"),
    subject: requireString(obj, "subject"),
    role: requireString(obj, "role"),
    secret: requireString(obj, "secret", 256),
  };
}

export type ResolveRequest = Readonly<{outcome: AppealOutcome; note: string | null}>;

export function validateResolveRequest(body: unknown): ResolveRequest {
  const obj = requireObject(body, "请求体");
  const outcome = obj["outcome"];
  if (!isAppealOutcome(outcome)) {
    throw badRequest("invalid_payload", "outcome 必须是 overturn | uphold");
  }
  return {outcome, note: optionalString(obj, "note") ?? null};
}

export type PolicyPublishRequest = Readonly<{version: number; name: string; rules: unknown}>;

export function validatePolicyPublishRequest(body: unknown): PolicyPublishRequest {
  const obj = requireObject(body, "请求体");
  return {
    version: requirePositiveInt(obj, "version"),
    name: requireString(obj, "name", 128),
    rules: obj["rules"],
  };
}
