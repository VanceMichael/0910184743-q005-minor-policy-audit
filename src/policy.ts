/**
 * 策略引擎：按 (年龄段 × 内容风险) 矩阵给出处置，监护关系可触发覆盖。
 * 策略版本按租户单调递增，投影中的 policy_version 只升不降——
 * 迟到的旧版本事件不会撤销更严格的新限制。
 */
export const AGE_BANDS = ["under_13", "13_to_15", "16_to_17", "adult"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** 与 contracts/policy.json 对齐的处置结果。 */
export const DECISION_OUTCOMES = ["allow", "limit", "block", "review"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export type PolicyRules = Readonly<{
  matrix: Record<string, Record<string, string>>;
  guardian_override?: {
    bands: readonly string[];
    from: string;
    to: string;
  } | null;
}>;

export type PolicySeed = Readonly<{
  version: number;
  name: string;
  rules: PolicyRules;
}>;

/** 租户首次出现时随租户一起供应的默认策略（v1 与 contracts/policy.json 同名）。 */
export const DEFAULT_POLICIES: readonly PolicySeed[] = [
  {
    version: 1,
    name: "minor-safety-1",
    rules: {
      matrix: {
        low: {under_13: "allow", "13_to_15": "allow", "16_to_17": "allow", adult: "allow"},
        medium: {under_13: "limit", "13_to_15": "limit", "16_to_17": "allow", adult: "allow"},
        high: {under_13: "block", "13_to_15": "block", "16_to_17": "limit", adult: "allow"},
        critical: {under_13: "block", "13_to_15": "block", "16_to_17": "block", adult: "limit"},
      },
      guardian_override: {bands: ["13_to_15", "16_to_17"], from: "block", to: "review"},
    },
  },
  {
    version: 2,
    name: "minor-safety-2",
    rules: {
      matrix: {
        low: {under_13: "limit", "13_to_15": "allow", "16_to_17": "allow", adult: "allow"},
        medium: {under_13: "block", "13_to_15": "limit", "16_to_17": "limit", adult: "allow"},
        high: {under_13: "block", "13_to_15": "block", "16_to_17": "block", adult: "limit"},
        critical: {under_13: "block", "13_to_15": "block", "16_to_17": "block", adult: "block"},
      },
      guardian_override: null,
    },
  },
];

export function isAgeBand(value: unknown): value is AgeBand {
  return typeof value === "string" && (AGE_BANDS as readonly string[]).includes(value);
}

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

export function isDecisionOutcome(value: unknown): value is DecisionOutcome {
  return typeof value === "string" && (DECISION_OUTCOMES as readonly string[]).includes(value);
}

export type PolicyFacts = Readonly<{
  ageBand: AgeBand | null;
  guardianshipStatus: string;
  riskLevel: RiskLevel;
}>;

export type PolicyVerdict = Readonly<{
  outcome: DecisionOutcome;
  reasonCode: string;
  /** 实际参与判定的年龄段（未验证年龄时按最严格档） */
  effectiveAgeBand: AgeBand;
}>;

/**
 * 评估内容风险。年龄证据缺失时按最严格年龄段（under_13）处理，
 * 并在 reason_code 中标注，便于事后解释“误拦”。
 */
export function evaluateContentPolicy(rules: PolicyRules, facts: PolicyFacts): PolicyVerdict {
  const ageUnverified = facts.ageBand === null;
  const band: AgeBand = facts.ageBand ?? "under_13";
  const row = rules.matrix[facts.riskLevel];
  const raw = row?.[band];
  const base: DecisionOutcome = isDecisionOutcome(raw) ? raw : "review";
  let outcome = base;
  let reason = ageUnverified ? "age_unverified_default_band" : "policy_matrix";

  const override = rules.guardian_override;
  if (
    override &&
    facts.guardianshipStatus === "active" &&
    override.bands.includes(band) &&
    base === override.from &&
    isDecisionOutcome(override.to)
  ) {
    outcome = override.to;
    reason = ageUnverified ? "age_unverified_guardian_override" : "guardian_override";
  }
  return {outcome, reasonCode: reason, effectiveAgeBand: band};
}

/** 处置结果 → 投影限制级别（0 无限制 / 1 受限 / 2 阻断）。 */
export function restrictionForOutcome(outcome: DecisionOutcome): number {
  switch (outcome) {
    case "allow":
      return 0;
    case "limit":
    case "review":
      return 1;
    case "block":
      return 2;
  }
}

/** 宽松校验策略规则结构（发布新版本时用）。 */
export function isPolicyRules(value: unknown): value is PolicyRules {
  if (typeof value !== "object" || value === null) return false;
  const rules = value as {matrix?: unknown};
  if (typeof rules.matrix !== "object" || rules.matrix === null) return false;
  for (const row of Object.values(rules.matrix as Record<string, unknown>)) {
    if (typeof row !== "object" || row === null) return false;
    for (const cell of Object.values(row as Record<string, unknown>)) {
      if (!isDecisionOutcome(cell)) return false;
    }
  }
  return true;
}
