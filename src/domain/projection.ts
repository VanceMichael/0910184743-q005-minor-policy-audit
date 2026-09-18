import type {
  AgeEvidencePayload,
  Decision,
  Envelope,
  GuardianAuthorizationPayload,
  ProjectionState,
} from "./types.js";

function applyAgeEvidence(state: ProjectionState, seq: number, payload: AgeEvidencePayload): ProjectionState {
  // 同一账号的年龄证据只接受序号更新的一条；旧证据永不覆盖新证据
  if (state.ageBandSeq !== null && seq <= state.ageBandSeq) {
    return state;
  }
  return {...state, ageBand: payload.age_band, ageKnown: true, ageBandSeq: seq};
}

function applyGuardian(state: ProjectionState, seq: number, payload: GuardianAuthorizationPayload): ProjectionState {
  const previous = state.guardians[payload.guardian_id];
  // 乱序重放保护：旧序号的授权变化不得覆盖新序号状态
  if (previous && seq <= previous.seq) {
    return state;
  }
  const guardians = {
    ...state.guardians,
    [payload.guardian_id]: {
      status: payload.action === "grant" ? ("active" as const) : ("revoked" as const),
      scope: payload.scope ?? null,
      seq,
    },
  };
  return {...state, guardians};
}

function applyContent(state: ProjectionState, event: Envelope, decision: Decision): ProjectionState {
  return {
    ...state,
    latestContentEventId: event.eventId,
    latestDecision: decision,
  };
}

/** 将一条事件按序 fold 进投影。content_risk 需要的裁决结果由调用方传入 */
export function applyEvent(
  state: ProjectionState,
  event: Envelope,
  contentDecision?: Decision,
): ProjectionState {
  const next: ProjectionState = {
    ...applyKind(state, event, contentDecision),
    revision: event.sourceSeq,
  };
  return next;
}

function applyKind(state: ProjectionState, event: Envelope, contentDecision?: Decision): ProjectionState {
  switch (event.kind) {
    case "age_evidence":
      return applyAgeEvidence(state, event.sourceSeq, event.payload as AgeEvidencePayload);
    case "guardian_authorization":
      return applyGuardian(state, event.sourceSeq, event.payload as GuardianAuthorizationPayload);
    case "content_risk":
      return applyContent(state, event, contentDecision!);
    case "appeal":
      // 申诉不改变账号事实投影（年龄段/监护关系），其结果在审计表中引用原决定
      return state;
  }
}

export function guardianActive(state: ProjectionState): boolean {
  return Object.values(state.guardians).some((g) => g.status === "active");
}
