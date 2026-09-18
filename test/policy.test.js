import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {decide, reviewAppeal, CURRENT_POLICY_VERSION, hasActiveGuardian} from "../dist/domain/policy.js";
import {applyEvent, guardianActive} from "../dist/domain/projection.js";
import {initialProjection} from "../dist/domain/types.js";
import {parseEnvelope, ValidationError} from "../dist/domain/validation.js";
import {buildAuthHeader, canonicalString, bodyHash} from "../dist/auth.js";

function ctx(over = {}) {
  return {policyVersion: CURRENT_POLICY_VERSION, ageBand: "under_13", ageKnown: true, guardianActive: false, ...over};
}

test("策略契约包含版本、年龄段、角色与决定", async () => {
  const policy = JSON.parse(await readFile(new URL("../contracts/policy.json", import.meta.url), "utf8"));
  assert.equal(policy.version, CURRENT_POLICY_VERSION);
  assert.deepEqual(policy.roles, ["guardian", "reviewer", "auditor"]);
  assert.deepEqual(policy.decisions, ["allow", "limit", "block", "review"]);
});

test("未知年龄段一律进入人工复核", () => {
  assert.equal(decide(CURRENT_POLICY_VERSION, ctx({ageKnown: false, ageBand: null}), "high").decision, "review");
  assert.equal(decide(CURRENT_POLICY_VERSION, ctx({ageKnown: false, ageBand: null}), "low").decision, "review");
});

test("under_13 无监护人高风险拦截，有监护人高风险仍拦截", () => {
  assert.equal(decide(CURRENT_POLICY_VERSION, ctx(), "high").decision, "block");
  assert.equal(decide(CURRENT_POLICY_VERSION, ctx({guardianActive: true}), "high").decision, "block");
  assert.equal(decide(CURRENT_POLICY_VERSION, ctx({guardianActive: true}), "low").decision, "allow");
  assert.equal(decide(CURRENT_POLICY_VERSION, ctx(), "low").decision, "limit");
});

test("16_to_17 有监护人对中风险放行，体现监护关系差异", () => {
  assert.equal(decide(CURRENT_POLICY_VERSION, ctx({ageBand: "16_to_17", guardianActive: true}), "medium").decision, "allow");
  assert.equal(decide(CURRENT_POLICY_VERSION, ctx({ageBand: "16_to_17", guardianActive: false}), "medium").decision, "limit");
});

test("投影 fold：年龄证据与监护授权按序推进", () => {
  let s = initialProjection;
  s = applyEvent(s, {eventId: "e1", tenantId: "t", accountId: "a", sourceSeq: 1, kind: "age_evidence", payload: {age_band: "13_to_15"}});
  s = applyEvent(s, {eventId: "e2", tenantId: "t", accountId: "a", sourceSeq: 2, kind: "guardian_authorization", payload: {guardian_id: "g1", action: "grant"}});
  assert.equal(s.revision, 2);
  assert.equal(s.ageBand, "13_to_15");
  assert.equal(guardianActive(s), true);
  s = applyEvent(s, {eventId: "e3", tenantId: "t", accountId: "a", sourceSeq: 3, kind: "guardian_authorization", payload: {guardian_id: "g1", action: "revoke"}});
  assert.equal(guardianActive(s), false);
});

test("投影 fold：旧序号年龄证据不得覆盖新证据", () => {
  let s = applyEvent(initialProjection, {eventId: "e5", tenantId: "t", accountId: "a", sourceSeq: 5, kind: "age_evidence", payload: {age_band: "16_to_17"}});
  const older = applyEvent(s, {eventId: "e1", tenantId: "t", accountId: "a", sourceSeq: 1, kind: "age_evidence", payload: {age_band: "under_13"}});
  assert.equal(older.ageBand, "16_to_17");
  assert.equal(older.ageBandSeq, 5);
});

test("申诉复核：误报把高风险纠正为 low 后推翻 block", () => {
  const target = {
    policy_version: CURRENT_POLICY_VERSION,
    age_band: "under_13",
    age_band_known: true,
    guardian_snapshot: {guardians: {g1: {status: "active", seq: 2}}},
    risk_snapshot: {risk: "high"},
    decision: "block",
  };
  const review = reviewAppeal({
    target,
    appeal: {target_content_event_id: "c1", claim: "false_positive"},
    currentAgeBand: "under_13",
    currentAgeKnown: true,
    currentGuardianActive: true,
  });
  assert.equal(review.result, "overturned");
  assert.equal(review.reviewedDecision, "allow");
  // 复算沿用原策略版本，历史可解释
  assert.equal(review.reviewPolicyVersion, CURRENT_POLICY_VERSION);
});

test("申诉复核：结论一致时维持原决定", () => {
  const target = {
    policy_version: CURRENT_POLICY_VERSION,
    age_band: "under_13",
    age_band_known: true,
    guardian_snapshot: {guardians: {}},
    risk_snapshot: {risk: "low"},
    decision: "limit",
  };
  const review = reviewAppeal({
    target,
    appeal: {target_content_event_id: "c1", claim: "false_positive"},
    currentAgeBand: "under_13",
    currentAgeKnown: true,
    currentGuardianActive: false,
  });
  assert.equal(review.result, "maintained");
  assert.equal(review.reviewedDecision, "limit");
});

test("hasActiveGuardian 仅在存在 active 监护时为真", () => {
  assert.equal(hasActiveGuardian({guardians: {a: {status: "revoked"}}}), false);
  assert.equal(hasActiveGuardian({guardians: {a: {status: "active"}}}), true);
  assert.equal(hasActiveGuardian(null), false);
});

test("parseEnvelope 校验四要素并拒绝 body/路径不一致", () => {
  const env = parseEnvelope(
    {tenant_id: "t1", account_id: "a1", source_seq: "7", event_id: "ev1"},
    {kind: "age_evidence", payload: {age_band: "under_13"}},
  );
  assert.equal(env.sourceSeq, 7);
  assert.throws(
    () => parseEnvelope({tenant_id: "t1", account_id: "a1", source_seq: "7", event_id: "ev1"}, {kind: "age_evidence", payload: {age_band: "bogus"}}),
    ValidationError,
  );
  assert.throws(
    () => parseEnvelope({tenant_id: "t1", account_id: "a1", source_seq: "7", event_id: "ev1"}, {kind: "age_evidence", payload: {age_band: "under_13"}, tenant_id: "other"}),
    ValidationError,
  );
  assert.throws(
    () => parseEnvelope({tenant_id: "t1", account_id: "a1", source_seq: "0", event_id: "ev1"}, {kind: "age_evidence", payload: {age_band: "under_13"}}),
    ValidationError,
  );
});

test("签名：规范化串包含全部绑定要素，篡改 body 后哈希不同", () => {
  const raw = Buffer.from(JSON.stringify({kind: "age_evidence", payload: {age_band: "under_13"}}));
  const pathname = "/v1/tenants/t1/accounts/a1/events/1/ev1";
  const ts = "1700000000";
  const header = buildAuthHeader({method: "POST", pathname, tenant: "t1", keyId: "k1", secret: "s1", role: "reviewer", ts: Number(ts), rawBody: raw});
  assert.match(header, /^HMAC-SHA256 /);
  assert.match(header, /tenant="t1"/);
  assert.match(header, new RegExp(`ts="${ts}"`));
  const canonical = canonicalString({method: "POST", pathname, tenant: "t1", keyId: "k1", role: "reviewer", ts, bodyHashHex: bodyHash(raw)});
  assert.equal(canonical, ["POST", pathname, "t1", "k1", "reviewer", ts, bodyHash(raw)].join("\n"));
  assert.notEqual(bodyHash(raw), bodyHash(Buffer.from("{}")));
});
