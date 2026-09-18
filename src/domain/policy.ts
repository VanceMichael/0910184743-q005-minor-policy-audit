import type {
  AgeBand,
  AppealPayload,
  Decision,
  PolicyContext,
  PolicyVerdict,
  RiskLevel,
} from "./types.js";

/**
 * 版本化策略表。每个版本不可原地修改：策略升级时新增一个版本，
 * 历史决定行始终保存其当时使用的 policy_version，可随时按旧版规则解释。
 */
type PolicyRules = Readonly<{
  version: string;
  /** [年龄段][是否有生效监护人][风险等级] => 决定 */
  matrix: Readonly<Record<AgeBand, Readonly<Record<"with_guardian" | "without_guardian", Readonly<Record<RiskLevel, Decision>>>>>>;
  unknownAge: Readonly<Record<RiskLevel, Decision>>;
}>;

const POLICIES: ReadonlyArray<PolicyRules> = [
  {
    version: "minor-safety-1",
    unknownAge: {low: "review", medium: "review", high: "review"},
    matrix: {
      under_13: {
        with_guardian: {low: "allow", medium: "limit", high: "block"},
        without_guardian: {low: "limit", medium: "block", high: "block"},
      },
      "13_to_15": {
        with_guardian: {low: "allow", medium: "limit", high: "block"},
        without_guardian: {low: "limit", medium: "block", high: "block"},
      },
      "16_to_17": {
        with_guardian: {low: "allow", medium: "allow", high: "limit"},
        without_guardian: {low: "allow", medium: "limit", high: "block"},
      },
    },
  },
];

export const CURRENT_POLICY_VERSION = POLICIES[POLICIES.length - 1]!.version;
const POLICY_BY_VERSION = new Map(POLICIES.map((p) => [p.version, p]));

export function policyExists(version: string): boolean {
  return POLICY_BY_VERSION.has(version);
}

/** 依据“当时”的年龄段、监护关系与指定策略版本裁决内容动作 */
export function decide(policyVersion: string, context: PolicyContext, risk: RiskLevel): PolicyVerdict {
  const policy = POLICY_BY_VERSION.get(policyVersion);
  if (!policy) {
    throw new Error(`未知策略版本：${policyVersion}`);
  }
  if (!context.ageKnown || context.ageBand === null) {
    return {
      decision: policy.unknownAge[risk],
      rationale: `年龄段未知，风险=${risk}，进入人工复核（${policyVersion}）`,
    };
  }
  const guardianKey = context.guardianActive ? "with_guardian" : "without_guardian";
  const decision = policy.matrix[context.ageBand][guardianKey][risk];
  return {
    decision,
    rationale:
      `年龄段=${context.ageBand}，监护=${context.guardianActive ? "生效" : "无生效监护人"}，` +
      `风险=${risk} => ${decision}（${policyVersion}）`,
  };
}

export type StoredDecisionSnapshot = Readonly<{
  policy_version: string;
  age_band: AgeBand | null;
  age_band_known: boolean;
  guardian_snapshot: unknown;
  risk_snapshot: unknown;
  decision: Decision;
  rationale: string;
}>;

export type AppealReviewInput = Readonly<{
  target: StoredDecisionSnapshot;
  appeal: AppealPayload;
  /** 申诉时刻的当前投影（new_evidence 使用更新后的年龄段/监护关系） */
  currentAgeBand: AgeBand | null;
  currentAgeKnown: boolean;
  currentGuardianActive: boolean;
}>;

export type AppealReview = Readonly<{
  result: "overturned" | "maintained";
  reviewedDecision: Decision;
  reviewPolicyVersion: string;
  reason: string;
}>;

/**
 * 复核一条不可变决定：
 *  - false_positive：复现“当时”的年龄段/监护/策略版本，仅把风险纠正为 low 后重算；
 *  - new_evidence：使用申诉时刻的年龄段与监护关系，按当前策略版本重算原风险；
 *  - procedural：按当前策略版本重算当时输入，规则结论不同即视为程序瑕疵推翻。
 * 结论与原决定不同 => overturned，否则 maintained。
 */
export function reviewAppeal(input: AppealReviewInput): AppealReview {
  const {target, appeal} = input;

  if (appeal.claim === "false_positive") {
    const verdict = decide(target.policy_version, {
      policyVersion: target.policy_version,
      ageBand: target.age_band,
      ageKnown: target.age_band_known,
      guardianActive: hasActiveGuardian(target.guardian_snapshot),
    }, "low");
    return finalizeAppeal(target, verdict.decision, target.policy_version,
      `误报申诉：按原快照将风险纠正为 low 后复算（${target.policy_version}）`);
  }

  if (appeal.claim === "new_evidence") {
    const risk = (target.risk_snapshot as {risk?: RiskLevel}).risk ?? "medium";
    const verdict = decide(CURRENT_POLICY_VERSION, {
      policyVersion: CURRENT_POLICY_VERSION,
      ageBand: input.currentAgeBand,
      ageKnown: input.currentAgeKnown,
      guardianActive: input.currentGuardianActive,
    }, risk);
    return finalizeAppeal(target, verdict.decision, CURRENT_POLICY_VERSION,
      `新证据申诉：按当前年龄段/监护关系以 ${CURRENT_POLICY_VERSION} 复算风险=${risk}`);
  }

  // procedural
  const risk = (target.risk_snapshot as {risk?: RiskLevel}).risk ?? "medium";
  const verdict = decide(CURRENT_POLICY_VERSION, {
    policyVersion: CURRENT_POLICY_VERSION,
    ageBand: target.age_band,
    ageKnown: target.age_band_known,
    guardianActive: hasActiveGuardian(target.guardian_snapshot),
  }, risk);
  return finalizeAppeal(target, verdict.decision, CURRENT_POLICY_VERSION,
    `程序申诉：以 ${CURRENT_POLICY_VERSION} 重放当时输入，结论${verdict.decision === target.decision ? "一致" : "不一致"}`);
}

function finalizeAppeal(
  target: StoredDecisionSnapshot,
  reviewed: Decision,
  reviewPolicyVersion: string,
  reason: string,
): AppealReview {
  return {
    result: reviewed === target.decision ? "maintained" : "overturned",
    reviewedDecision: reviewed,
    reviewPolicyVersion,
    reason,
  };
}

export function hasActiveGuardian(snapshot: unknown): boolean {
  if (typeof snapshot !== "object" || snapshot === null) return false;

  const guardians = (snapshot as {guardians?: Record<string, {status?: string}>}).guardians;
  if (!guardians) return false;
  return Object.values(guardians).some((g) => g?.status === "active");
}
