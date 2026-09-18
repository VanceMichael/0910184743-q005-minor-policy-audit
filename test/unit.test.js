import test from "node:test";
import assert from "node:assert/strict";
import {newTokenPayload, signToken, verifyToken} from "../dist/auth.js";
import {stableStringify, sha256Hex, hmacSha256Hex} from "../dist/cryptoUtil.js";
import {
  DEFAULT_POLICIES,
  evaluateContentPolicy,
  restrictionForOutcome,
} from "../dist/policy.js";
import {validateEventEnvelope} from "../dist/validation.js";

const V1 = DEFAULT_POLICIES[0].rules;
const V2 = DEFAULT_POLICIES[1].rules;

test("stableStringify 键序稳定", () => {
  const a = stableStringify({b: 1, a: {d: [1, 2], c: "x"}});
  const b = stableStringify({a: {c: "x", d: [1, 2]}, b: 1});
  assert.equal(a, b);
  assert.equal(sha256Hex(a), sha256Hex(b));
});

test("令牌签发与验签往返", () => {
  const payload = newTokenPayload("tenant-1", "ops", "auditor", 600);
  const token = signToken("secret-1", "k1", payload);
  const verified = verifyToken(token, "secret-1", payload.iat + 1);
  assert.equal(verified.keyId, "k1");
  assert.equal(verified.payload.tenant_id, "tenant-1");
  assert.equal(verified.payload.role, "auditor");
});

test("令牌篡改与错误密钥被拒绝", () => {
  const payload = newTokenPayload("tenant-1", "ops", "guardian", 600);
  const token = signToken("secret-1", "k1", payload);
  assert.throws(() => verifyToken(token, "wrong-secret", payload.iat + 1), /签名不匹配/);
  const tampered = `${token.slice(0, -2)}aa`;
  assert.throws(() => verifyToken(tampered, "secret-1", payload.iat + 1));
});

test("过期令牌被拒绝", () => {
  const payload = newTokenPayload("tenant-1", "ops", "reviewer", 10);
  const token = signToken("secret-1", "k1", payload);
  assert.throws(() => verifyToken(token, "secret-1", payload.exp + 1), /已过期/);
});

test("策略矩阵：v1 高风险对 13_to_15 阻断，监护覆盖降级为复核", () => {
  const blocked = evaluateContentPolicy(V1, {ageBand: "13_to_15", guardianshipStatus: "none", riskLevel: "high"});
  assert.equal(blocked.outcome, "block");
  const overridden = evaluateContentPolicy(V1, {ageBand: "13_to_15", guardianshipStatus: "active", riskLevel: "high"});
  assert.equal(overridden.outcome, "review");
  assert.equal(overridden.reasonCode, "guardian_override");
});

test("策略矩阵：under_13 不享受监护覆盖", () => {
  const verdict = evaluateContentPolicy(V1, {ageBand: "under_13", guardianshipStatus: "active", riskLevel: "high"});
  assert.equal(verdict.outcome, "block");
});

test("年龄未验证按最严格档并标注", () => {
  const verdict = evaluateContentPolicy(V1, {ageBand: null, guardianshipStatus: "none", riskLevel: "medium"});
  assert.equal(verdict.outcome, "limit");
  assert.equal(verdict.effectiveAgeBand, "under_13");
  assert.equal(verdict.reasonCode, "age_unverified_default_band");
});

test("v2 比 v1 更严格（medium 对 16_to_17 受限）", () => {
  const v1 = evaluateContentPolicy(V1, {ageBand: "16_to_17", guardianshipStatus: "none", riskLevel: "medium"});
  const v2 = evaluateContentPolicy(V2, {ageBand: "16_to_17", guardianshipStatus: "none", riskLevel: "medium"});
  assert.equal(v1.outcome, "allow");
  assert.equal(v2.outcome, "limit");
});

test("处置到限制级别映射", () => {
  assert.equal(restrictionForOutcome("allow"), 0);
  assert.equal(restrictionForOutcome("limit"), 1);
  assert.equal(restrictionForOutcome("review"), 1);
  assert.equal(restrictionForOutcome("block"), 2);
});

test("事件信封校验：合法与非法", () => {
  const ok = validateEventEnvelope({
    tenant_id: "t", account_id: "a", event_id: "e", source_seq: 1,
    kind: "age_evidence",
    payload: {age_band: "under_13", attestation_id: "att-1"},
  });
  assert.equal(ok.kind, "age_evidence");

  assert.throws(() => validateEventEnvelope({tenant_id: "t"}), /kind/);
  assert.throws(() => validateEventEnvelope({
    tenant_id: "t", account_id: "a", event_id: "e", source_seq: 0, kind: "age_evidence",
    payload: {age_band: "under_13", attestation_id: "x"},
  }), /source_seq/);
  assert.throws(() => validateEventEnvelope({
    tenant_id: "t", account_id: "a", event_id: "e", source_seq: 1, kind: "unknown",
    payload: {},
  }), /kind/);
  assert.throws(() => validateEventEnvelope({
    tenant_id: "t", account_id: "a", event_id: "e", source_seq: 1, kind: "content_risk",
    payload: {content_id: "c", risk_level: "extreme"},
  }), /risk_level/);
});

test("hmac 输出稳定", () => {
  assert.equal(hmacSha256Hex("k", "v"), hmacSha256Hex("k", "v"));
  assert.notEqual(hmacSha256Hex("k", "v"), hmacSha256Hex("k", "w"));
});
