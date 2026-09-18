import {
  AGE_BANDS,
  DECISIONS,
  EVENT_KINDS,
  type AgeEvidencePayload,
  type AppealPayload,
  type ContentRiskPayload,
  type Envelope,
  type EventKind,
  type EventPayload,
  type GuardianAuthorizationPayload,
} from "./types.js";

export class ValidationError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} 不能为空`);
  }
  const trimmed = value.trim();
  if (!ID_PATTERN.test(trimmed)) {
    throw new ValidationError(`${field} 只能包含字母数字与 _.:-，长度不超过 128`);
  }
  return trimmed;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("payload 必须是对象");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, allowed?: readonly string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} 必须是非空字符串`);
  }
  if (allowed && !allowed.includes(value)) {
    throw new ValidationError(`${field} 取值非法：${value}`);
  }
  return value;
}

function validateAgeEvidence(raw: Record<string, unknown>): AgeEvidencePayload {
  const age_band = requireString(raw.age_band, "age_band", AGE_BANDS) as AgeEvidencePayload["age_band"];
  let confidence: AgeEvidencePayload["confidence"];
  if (raw.confidence !== undefined) {
    confidence = requireString(raw.confidence, "confidence", ["low", "high"]) as "low" | "high";
  }
  return {age_band, ...(confidence ? {confidence} : {})};
}

function validateGuardian(raw: Record<string, unknown>): GuardianAuthorizationPayload {
  const guardian_id = requireIdentifier(raw.guardian_id, "guardian_id");
  const action = requireString(raw.action, "action", ["grant", "revoke"]) as "grant" | "revoke";
  const payload: GuardianAuthorizationPayload = {guardian_id, action};
  if (raw.scope !== undefined) {
    return {...payload, scope: requireString(raw.scope, "scope")};
  }
  return payload;
}

function validateContent(raw: Record<string, unknown>): ContentRiskPayload {
  const content_id = requireIdentifier(raw.content_id, "content_id");
  const action = requireString(raw.action, "action");
  const risk = requireString(raw.risk, "risk", ["low", "medium", "high"]) as ContentRiskPayload["risk"];
  const payload: ContentRiskPayload = {content_id, action, risk};
  if (raw.categories !== undefined) {
    if (!Array.isArray(raw.categories) || raw.categories.some((c) => typeof c !== "string")) {
      throw new ValidationError("categories 必须是字符串数组");
    }
    return {...payload, categories: raw.categories as string[]};
  }
  return payload;
}

function validateAppeal(raw: Record<string, unknown>): AppealPayload {
  const target_content_event_id = requireIdentifier(raw.target_content_event_id, "target_content_event_id");
  const claim = requireString(raw.claim, "claim", ["false_positive", "new_evidence", "procedural"]) as AppealPayload["claim"];
  const payload: AppealPayload = {target_content_event_id, claim};
  if (raw.requested_decision !== undefined) {
    requireString(raw.requested_decision, "requested_decision", DECISIONS);
    return {...payload, requested_decision: raw.requested_decision as AppealPayload["requested_decision"]};
  }
  if (raw.note !== undefined) {
    return {...payload, note: requireString(raw.note, "note")};
  }
  return payload;
}

function validatePayload(kind: EventKind, raw: unknown): EventPayload {
  const obj = requireObject(raw);
  switch (kind) {
    case "age_evidence":
      return validateAgeEvidence(obj);
    case "guardian_authorization":
      return validateGuardian(obj);
    case "content_risk":
      return validateContent(obj);
    case "appeal":
      return validateAppeal(obj);
  }
}

/** 校验并规范化入口事件；路径参数与 body 的标识必须一致，防止混用 */
export function parseEnvelope(path: {
  tenant_id?: string;
  account_id?: string;
  source_seq?: string;
  event_id?: string;
}, body: unknown): Envelope {
  const bodyObj = requireObject(body);
  const tenantId = requireIdentifier(path.tenant_id, "tenant_id");
  const accountId = requireIdentifier(path.account_id, "account_id");
  const eventId = requireIdentifier(path.event_id ?? (bodyObj.event_id as unknown), "event_id");

  const seqRaw = path.source_seq ?? bodyObj.source_seq;
  const sourceSeq = typeof seqRaw === "number" ? seqRaw : Number(seqRaw);
  if (!Number.isSafeInteger(sourceSeq) || sourceSeq < 1) {
    throw new ValidationError("source_seq 必须是正整数");
  }

  // 若 body 也携带标识，必须与路径一致（防请求走私/误投）
  for (const [key, pathValue] of [
    ["tenant_id", tenantId],
    ["account_id", accountId],
    ["event_id", eventId],
  ] as const) {
    if (bodyObj[key] !== undefined && bodyObj[key] !== pathValue) {
      throw new ValidationError(`body.${key} 与路径参数不一致`);
    }
  }
  if (bodyObj.source_seq !== undefined && Number(bodyObj.source_seq) !== sourceSeq) {
    throw new ValidationError("body.source_seq 与路径参数不一致");
  }

  const kind = requireString(bodyObj.kind ?? bodyObj.event_kind, "kind", EVENT_KINDS) as EventKind;
  const payload = validatePayload(kind, bodyObj.payload);
  return {eventId, tenantId, accountId, sourceSeq, kind, payload};
}
