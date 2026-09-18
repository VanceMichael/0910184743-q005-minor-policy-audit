import test from "node:test";
import assert from "node:assert/strict";
import {api, getToken, startApp, startPostgres, uniqueId} from "./helpers.js";

const TENANT = "t-it";
const ACCT = "acct-main";

let pg;
let app;
let tokens;
// 跨用例共享的审计锚点
let contentDecisionId;
let blockedDecisionId;
let appealId;

test.before(async () => {
  pg = await startPostgres();
  app = await startApp(pg.url);
  tokens = {
    guardian: await getToken(app.base, TENANT, "guardian", "guardian-1"),
    reviewer: await getToken(app.base, TENANT, "reviewer", "reviewer-1"),
    auditor: await getToken(app.base, TENANT, "auditor", "auditor-1"),
  };
});

test.after(async () => {
  await app.close();
  await pg.cleanup();
});

test("探活与就绪", async () => {
  const health = await api(app.base, {path: "/health"});
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");
  const ready = await api(app.base, {path: "/ready"});
  assert.equal(ready.status, 200);
});

test("签发令牌：错误引导密钥 401，非法角色 403", async () => {
  const bad = await api(app.base, {
    method: "POST", path: "/v1/auth/token",
    body: {tenant_id: TENANT, subject: "x", role: "reviewer", secret: "wrong"},
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, "invalid_bootstrap_secret");
  const badRole = await api(app.base, {
    method: "POST", path: "/v1/auth/token",
    body: {tenant_id: TENANT, subject: "x", role: "superadmin", secret: "test-bootstrap"},
  });
  assert.equal(badRole.status, 403);
});

test("未携带或伪造令牌 401", async () => {
  const noToken = await api(app.base, {path: `/v1/accounts/${ACCT}/projection`});
  assert.equal(noToken.status, 401);
  const forged = await api(app.base, {
    path: `/v1/accounts/${ACCT}/projection`,
    token: "mp1.aaaa.bbbb.cccc",
  });
  assert.equal(forged.status, 401);
});

test("摄入年龄证明：同事务落库 + 决策 + 审计", async () => {
  const res = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: ACCT, event_id: "e-age-1", source_seq: 1,
      kind: "age_evidence",
      payload: {age_band: "13_to_15", attestation_id: "att-1", method: "carrier"},
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, "applied");
  assert.equal(res.body.decision.outcome, "record");
  const projection = await api(app.base, {
    path: `/v1/accounts/${ACCT}/projection`, token: tokens.reviewer,
  });
  assert.equal(projection.body.projection.age_band, "13_to_15");
  assert.equal(projection.body.projection.last_applied_seq, 1);
});

test("重复投递返回首次决定（幂等）", async () => {
  const again = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: ACCT, event_id: "e-age-1", source_seq: 1,
      kind: "age_evidence",
      payload: {age_band: "13_to_15", attestation_id: "att-1", method: "carrier"},
    },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, "duplicate");
  const timeline = await api(app.base, {
    path: `/v1/accounts/${ACCT}/timeline`, token: tokens.auditor,
  });
  assert.equal(timeline.body.entries.length, 1);
});

test("幂等键被不同负载复用 → 409", async () => {
  const res = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: "acct-other", event_id: "e-age-1", source_seq: 1,
      kind: "age_evidence",
      payload: {age_band: "under_13", attestation_id: "att-9"},
    },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "event_id_conflict");
});

test("监护授权 + 内容风险：v1 监护覆盖 block→review", async () => {
  const acct = "acct-override";
  const guard = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: acct, event_id: "e-age-ov", source_seq: 1,
      kind: "age_evidence", policy_version: 1,
      payload: {age_band: "13_to_15", attestation_id: "att-ov"},
    },
  });
  assert.equal(guard.status, 201);
  await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: acct, event_id: "e-guard-1", source_seq: 2,
      kind: "guardianship", policy_version: 1,
      payload: {guardian_id: "g-1", relation: "parent", status: "active"},
    },
  });

  const risk = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: acct, event_id: "e-risk-1", source_seq: 3,
      kind: "content_risk", policy_version: 1,
      payload: {content_id: "c-1", risk_level: "high", categories: ["violence"]},
    },
  });
  assert.equal(risk.status, 201);
  assert.equal(risk.body.decision.outcome, "review");
  assert.equal(risk.body.decision.reason_code, "guardian_override");
  assert.equal(risk.body.decision.policy_version, 1);
  contentDecisionId = risk.body.decision.id;
  const projection = await api(app.base, {
    path: `/v1/accounts/${acct}/projection`, token: tokens.reviewer,
  });
  assert.equal(projection.body.projection.restriction_level, 1);
});

test("乱序旧序号：记录为 stale 可查询，但投影不回退", async () => {
  const seq5 = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: ACCT, event_id: "e-risk-2", source_seq: 5,
      kind: "content_risk",
      payload: {content_id: "c-2", risk_level: "low"},
    },
  });
  assert.equal(seq5.body.status, "applied");
  assert.equal(seq5.body.decision.outcome, "allow");

  const late = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: ACCT, event_id: "e-risk-late", source_seq: 4,
      kind: "content_risk",
      payload: {content_id: "c-3", risk_level: "critical"},
    },
  });
  assert.equal(late.status, 201);
  assert.equal(late.body.status, "stale");
  assert.equal(late.body.decision.applied, false);

  const projection = await api(app.base, {
    path: `/v1/accounts/${ACCT}/projection`, token: tokens.auditor,
  });
  assert.equal(projection.body.projection.last_applied_seq, 5);
  assert.equal(projection.body.projection.restriction_level, 0);

  const timeline = await api(app.base, {
    path: `/v1/accounts/${ACCT}/timeline`, token: tokens.auditor,
  });
  const seqs = timeline.body.entries.map((entry) => entry.event.source_seq);
  assert.deepEqual(seqs, [1, 4, 5]);
  const staleEntry = timeline.body.entries.find((entry) => entry.event.source_seq === 4);
  assert.equal(staleEntry.event.status, "stale");
});

test("同一序号不同事件 → 409 且事务整体回滚", async () => {
  const before = await api(app.base, {
    path: `/v1/accounts/${ACCT}/projection`, token: tokens.auditor,
  });
  const res = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: ACCT, event_id: "e-risk-dup-seq", source_seq: 5,
      kind: "content_risk",
      payload: {content_id: "c-x", risk_level: "low"},
    },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "source_seq_conflict");
  const after = await api(app.base, {
    path: `/v1/accounts/${ACCT}/projection`, token: tokens.auditor,
  });
  assert.deepEqual(after.body, before.body);
});

test("策略版本单调：旧版本事件不会撤销更严格的新限制", async () => {
  const v2 = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: ACCT, event_id: "e-risk-v2", source_seq: 6,
      kind: "content_risk", policy_version: 2,
      payload: {content_id: "c-4", risk_level: "medium"},
    },
  });
  assert.equal(v2.body.decision.policy_version, 2);
  assert.equal(v2.body.decision.outcome, "limit");

  const downgrade = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: ACCT, event_id: "e-risk-v1late", source_seq: 7,
      kind: "content_risk", policy_version: 1,
      payload: {content_id: "c-5", risk_level: "low"},
    },
  });
  assert.equal(downgrade.status, 201);
  // 决策仍按更严格的 v2 记录，投影版本不回退
  assert.equal(downgrade.body.decision.policy_version, 2);
  const projection = await api(app.base, {
    path: `/v1/accounts/${ACCT}/projection`, token: tokens.reviewer,
  });
  assert.equal(projection.body.projection.policy_version, 2);
});

test("引用不存在的策略版本 → 422 且整体回滚", async () => {
  const res = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: ACCT, event_id: "e-risk-v99", source_seq: 8,
      kind: "content_risk", policy_version: 99,
      payload: {content_id: "c-6", risk_level: "low"},
    },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "unknown_policy_version");
  const projection = await api(app.base, {
    path: `/v1/accounts/${ACCT}/projection`, token: tokens.auditor,
  });
  assert.equal(projection.body.projection.last_applied_seq, 7);
});

test("非法负载 400：无事件、无决定、投影不变", async () => {
  const before = await api(app.base, {
    path: `/v1/accounts/${ACCT}/projection`, token: tokens.auditor,
  });
  const res = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: ACCT, event_id: "e-bad", source_seq: 8,
      kind: "content_risk",
      payload: {content_id: "c-7", risk_level: "catastrophic"},
    },
  });
  assert.equal(res.status, 400);
  const after = await api(app.base, {
    path: `/v1/accounts/${ACCT}/projection`, token: tokens.auditor,
  });
  assert.deepEqual(after.body, before.body);
});

test("越权：跨租户读 404、跨租户写 403", async () => {
  const otherToken = await getToken(app.base, "t-other", "auditor", "auditor-9");
  const read = await api(app.base, {
    path: `/v1/decisions/${contentDecisionId}`, token: otherToken,
  });
  assert.equal(read.status, 404);
  const projection = await api(app.base, {
    path: `/v1/accounts/${ACCT}/projection`, token: otherToken,
  });
  assert.equal(projection.status, 404);
  const write = await api(app.base, {
    method: "POST", path: "/v1/events", token: otherToken,
    body: {
      tenant_id: TENANT, account_id: ACCT, event_id: "e-cross", source_seq: 9,
      kind: "content_risk",
      payload: {content_id: "c-8", risk_level: "low"},
    },
  });
  assert.equal(write.status, 403);
  assert.equal(write.body.error, "tenant_mismatch");
});

test("角色字段：guardian 不见 key_id，auditor 可见哈希链", async () => {
  const guardian = await api(app.base, {
    path: `/v1/decisions/${contentDecisionId}`, token: tokens.guardian,
  });
  assert.equal(guardian.status, 200);
  assert.ok(!("key_id" in guardian.body.decision));
  assert.ok(!("policy_version" in guardian.body.decision));
  assert.ok(!("payload_hash" in guardian.body.decision));

  const reviewer = await api(app.base, {
    path: `/v1/decisions/${contentDecisionId}`, token: tokens.reviewer,
  });
  assert.ok("policy_version" in reviewer.body.decision);
  assert.ok(!("key_id" in reviewer.body.decision));

  const auditor = await api(app.base, {
    path: `/v1/decisions/${contentDecisionId}`, token: tokens.auditor,
  });
  assert.equal(auditor.body.decision.key_id, "k1");
  assert.ok(typeof auditor.body.decision.prev_hash === "string");
  assert.ok(typeof auditor.body.decision.decision_hash === "string");
});

test("角色门控：guardian 不能轮换密钥/解决申诉/发策略", async () => {
  const rotate = await api(app.base, {
    method: "POST", path: "/v1/auth/rotate", token: tokens.guardian, body: {},
  });
  assert.equal(rotate.status, 403);
  const publish = await api(app.base, {
    method: "POST", path: "/v1/policies", token: tokens.guardian,
    body: {version: 3, name: "x", rules: {matrix: {}}},
  });
  assert.equal(publish.status, 403);
});

test("申诉推翻：引用被推翻的决定并前向解除限制", async () => {
  const acct = "acct-appeal";
  await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: acct, event_id: "ap-age", source_seq: 1,
      kind: "age_evidence",
      payload: {age_band: "under_13", attestation_id: "att-2"},
    },
  });
  const blocked = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: acct, event_id: "ap-risk", source_seq: 2,
      kind: "content_risk",
      payload: {content_id: "c-bad", risk_level: "high"},
    },
  });
  assert.equal(blocked.body.decision.outcome, "block");
  blockedDecisionId = blocked.body.decision.id;

  appealId = "appeal-1";
  const opened = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.guardian,
    body: {
      tenant_id: TENANT, account_id: acct, event_id: "ap-appeal", source_seq: 3,
      kind: "appeal",
      payload: {appeal_id: appealId, target_decision_id: blockedDecisionId, reason: "误拦"},
    },
  });
  assert.equal(opened.status, 201);
  assert.equal(opened.body.appeal.status, "pending");

  const denied = await api(app.base, {
    method: "POST", path: `/v1/appeals/${appealId}/resolve`, token: tokens.guardian,
    body: {outcome: "overturn"},
  });
  assert.equal(denied.status, 403);

  const resolved = await api(app.base, {
    method: "POST", path: `/v1/appeals/${appealId}/resolve`, token: tokens.reviewer,
    body: {outcome: "overturn", note: "复核确认误拦"},
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.appeal.status, "overturned");
  assert.equal(resolved.body.appeal.overturned_decision_id, blockedDecisionId);
  assert.ok(resolved.body.appeal.resolution_decision_id);

  const projection = await api(app.base, {
    path: `/v1/accounts/${acct}/projection`, token: tokens.reviewer,
  });
  assert.equal(projection.body.projection.restriction_level, 0);

  const again = await api(app.base, {
    method: "POST", path: `/v1/appeals/${appealId}/resolve`, token: tokens.reviewer,
    body: {outcome: "uphold"},
  });
  assert.equal(again.status, 409);

  const timeline = await api(app.base, {
    path: `/v1/accounts/${acct}/timeline`, token: tokens.auditor,
  });
  const appealEntry = timeline.body.entries.find((entry) => entry.event.kind === "appeal");
  assert.equal(appealEntry.appeal.status, "overturned");
  assert.equal(appealEntry.resolution_decision.kind, "appeal_resolution");
  assert.equal(appealEntry.resolution_decision.outcome, "overturn");
});

test("申诉维持：限制保持，引用被维持的决定", async () => {
  const acct = "acct-appeal-2";
  await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: acct, event_id: "ap2-age", source_seq: 1,
      kind: "age_evidence",
      payload: {age_band: "under_13", attestation_id: "att-3"},
    },
  });
  const blocked = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: acct, event_id: "ap2-risk", source_seq: 2,
      kind: "content_risk",
      payload: {content_id: "c-bad2", risk_level: "critical"},
    },
  });
  const targetId = blocked.body.decision.id;
  await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: acct, event_id: "ap2-appeal", source_seq: 3,
      kind: "appeal",
      payload: {appeal_id: "appeal-2", target_decision_id: targetId},
    },
  });
  const resolved = await api(app.base, {
    method: "POST", path: "/v1/appeals/appeal-2/resolve", token: tokens.reviewer,
    body: {outcome: "uphold"},
  });
  assert.equal(resolved.body.appeal.status, "upheld");
  assert.equal(resolved.body.appeal.upheld_decision_id, targetId);
  const projection = await api(app.base, {
    path: `/v1/accounts/${acct}/projection`, token: tokens.reviewer,
  });
  assert.equal(projection.body.projection.restriction_level, 2);
});

test("申诉目标缺失 → 422；申诉事件自带 outcome 立即解决", async () => {
  const missing = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: "acct-appeal", event_id: "ap-ghost", source_seq: 4,
      kind: "appeal",
      payload: {appeal_id: "appeal-ghost", target_decision_id: 999999},
    },
  });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error, "appeal_target_not_found");

  const inline = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: "acct-appeal-2", event_id: "ap2-appeal-2", source_seq: 4,
      kind: "appeal",
      payload: {appeal_id: "appeal-3", target_decision_id: 1, outcome: "overturn"},
    },
  });
  // target_decision_id 1 属于 acct-main，账号不匹配 → 422
  assert.equal(inline.status, 422);
  assert.equal(inline.body.error, "appeal_account_mismatch");
});

test("密钥轮换：历史决定保持原 key_id，旧令牌仍可验签", async () => {
  const before = await api(app.base, {
    path: `/v1/decisions/${contentDecisionId}`, token: tokens.auditor,
  });
  assert.equal(before.body.decision.key_id, "k1");

  const rotated = await api(app.base, {
    method: "POST", path: "/v1/auth/rotate", token: tokens.reviewer, body: {},
  });
  assert.equal(rotated.status, 201);
  assert.equal(rotated.body.key_id, "k2");

  const fresh = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: ACCT, event_id: "e-risk-k2", source_seq: 8,
      kind: "content_risk",
      payload: {content_id: "c-9", risk_level: "low"},
    },
  });
  assert.equal(fresh.status, 201);
  const freshDecision = await api(app.base, {
    path: `/v1/decisions/${fresh.body.decision.id}`, token: tokens.auditor,
  });
  assert.equal(freshDecision.body.decision.key_id, "k2");

  const historical = await api(app.base, {
    path: `/v1/decisions/${contentDecisionId}`, token: tokens.auditor,
  });
  assert.equal(historical.body.decision.key_id, "k1");

  // 轮换前签发的令牌（k1，已 retired）仍在有效期内可用
  const withOldToken = await api(app.base, {
    path: `/v1/accounts/${ACCT}/projection`, token: tokens.reviewer,
  });
  assert.equal(withOldToken.status, 200);
});

test("并发同账号：只有一个当前投影，序号只增", async () => {
  const acct = "acct-race";
  const events = Array.from({length: 10}, (_, index) => ({
    tenant_id: TENANT, account_id: acct, event_id: `race-${index + 1}`, source_seq: index + 1,
    kind: "content_risk",
    payload: {content_id: `rc-${index + 1}`, risk_level: "low"},
  }));
  const results = await Promise.all(events.map((body) => api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer, body,
  })));
  for (const res of results) {
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const projection = await api(app.base, {
    path: `/v1/accounts/${acct}/projection`, token: tokens.auditor,
  });
  assert.equal(projection.body.projection.last_applied_seq, 10);
  assert.equal(projection.body.projection.decision_count, 10);
  const count = await app.pool.query(
    "SELECT count(*)::int AS n FROM account_projection WHERE tenant_id = $1 AND account_id = $2",
    [TENANT, acct],
  );
  assert.equal(count.rows[0].n, 1);
});

test("并发重复投递：同一事件只落库一次，决定一致", async () => {
  const acct = "acct-race-dup";
  const body = {
    tenant_id: TENANT, account_id: acct, event_id: "race-dup-1", source_seq: 1,
    kind: "age_evidence",
    payload: {age_band: "under_13", attestation_id: "att-race"},
  };
  const results = await Promise.all(Array.from({length: 6}, () => api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer, body,
  })));
  const statuses = results.map((res) => res.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 201]);
  const decisionIds = new Set(results.map((res) => res.body.decision.id));
  assert.equal(decisionIds.size, 1);
  const count = await app.pool.query(
    "SELECT count(*)::int AS n FROM account_events WHERE tenant_id = $1 AND account_id = $2",
    [TENANT, acct],
  );
  assert.equal(count.rows[0].n, 1);
});

test("审计表不可变：UPDATE/DELETE 被拒绝", async () => {
  await assert.rejects(
    app.pool.query("UPDATE decisions SET outcome = 'allow'"),
    /immutable_table/,
  );
  await assert.rejects(
    app.pool.query("DELETE FROM account_events"),
    /immutable_table/,
  );
});

test("策略发布：版本必须单调递增", async () => {
  const list = await api(app.base, {path: "/v1/policies", token: tokens.auditor});
  assert.deepEqual(list.body.policies.map((p) => p.version), [1, 2]);

  const rules = {matrix: {low: {under_13: "allow", "13_to_15": "allow", "16_to_17": "allow", adult: "allow"}}};
  const backwards = await api(app.base, {
    method: "POST", path: "/v1/policies", token: tokens.reviewer,
    body: {version: 2, name: "minor-safety-2x", rules},
  });
  assert.equal(backwards.status, 409);
  assert.equal(backwards.body.error, "policy_version_not_monotonic");

  const forward = await api(app.base, {
    method: "POST", path: "/v1/policies", token: tokens.reviewer,
    body: {version: 3, name: "minor-safety-3", rules},
  });
  assert.equal(forward.status, 201);

  const invalid = await api(app.base, {
    method: "POST", path: "/v1/policies", token: tokens.reviewer,
    body: {version: 4, name: "broken", rules: {matrix: {low: {under_13: "shred"}}}},
  });
  assert.equal(invalid.status, 400);
});

test("事件 ID 全局唯一约束兜底：fixtures 样例可摄入", async () => {
  const acct = uniqueId("acct-fixture");
  const res = await api(app.base, {
    method: "POST", path: "/v1/events", token: tokens.reviewer,
    body: {
      tenant_id: TENANT, account_id: acct, event_id: uniqueId("evt"), source_seq: 1,
      kind: "age_evidence",
      payload: {age_band: "16_to_17", attestation_id: "att-f"},
    },
  });
  assert.equal(res.status, 201);
});
