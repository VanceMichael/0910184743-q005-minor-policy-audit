import test from "node:test";
import assert from "node:assert/strict";
import {api, getToken, startApp, startPostgres} from "./helpers.js";

/**
 * 数据库重启一致性：写入完整时间线（含申诉与解决），停止并重启 PostgreSQL，
 * 恢复后的时间线 / 投影 / 决定必须与重启前逐字节一致。
 */
test("数据库重启后时间线与重启前一致", async () => {
  const pg = await startPostgres();
  const tenant = "t-restart";
  const acct = "acct-restart";

  let app = await startApp(pg.url);
  const reviewer = await getToken(app.base, tenant, "reviewer", "ops-1");
  const auditor = await getToken(app.base, tenant, "auditor", "audit-1");

  const seed = async (body, token = reviewer) => {
    const res = await api(app.base, {method: "POST", path: "/v1/events", token, body});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };

  await seed({
    tenant_id: tenant, account_id: acct, event_id: "r-age", source_seq: 1,
    kind: "age_evidence",
    payload: {age_band: "13_to_15", attestation_id: "att-r1"},
  });
  await seed({
    tenant_id: tenant, account_id: acct, event_id: "r-guard", source_seq: 2,
    kind: "guardianship",
    payload: {guardian_id: "g-r1", relation: "legal_guardian", status: "active"},
  });
  const blocked = await seed({
    tenant_id: tenant, account_id: acct, event_id: "r-risk", source_seq: 3,
    kind: "content_risk",
    payload: {content_id: "c-r1", risk_level: "critical"},
  });
  await seed({
    tenant_id: tenant, account_id: acct, event_id: "r-appeal", source_seq: 4,
    kind: "appeal",
    payload: {appeal_id: "appeal-r1", target_decision_id: blocked.decision.id, reason: "重启测试"},
  });
  const resolved = await api(app.base, {
    method: "POST", path: "/v1/appeals/appeal-r1/resolve", token: reviewer,
    body: {outcome: "overturn", note: "重启前解决"},
  });
  assert.equal(resolved.status, 200);

  const timelineBefore = await api(app.base, {
    path: `/v1/accounts/${acct}/timeline`, token: auditor,
  });
  const projectionBefore = await api(app.base, {
    path: `/v1/accounts/${acct}/projection`, token: auditor,
  });
  const decisionBefore = await api(app.base, {
    path: `/v1/decisions/${blocked.decision.id}`, token: auditor,
  });
  const appealBefore = await api(app.base, {
    path: "/v1/appeals/appeal-r1", token: auditor,
  });
  assert.equal(timelineBefore.body.entries.length, 4);

  // 停止应用与数据库，再原卷重启数据库
  await app.close();
  await pg.pg.stop();
  await pg.pg.start();

  app = await startApp(pg.url);

  const timelineAfter = await api(app.base, {
    path: `/v1/accounts/${acct}/timeline`, token: auditor,
  });
  const projectionAfter = await api(app.base, {
    path: `/v1/accounts/${acct}/projection`, token: auditor,
  });
  const decisionAfter = await api(app.base, {
    path: `/v1/decisions/${blocked.decision.id}`, token: auditor,
  });
  const appealAfter = await api(app.base, {
    path: "/v1/appeals/appeal-r1", token: auditor,
  });

  assert.deepEqual(timelineAfter.body, timelineBefore.body);
  assert.deepEqual(projectionAfter.body, projectionBefore.body);
  assert.deepEqual(decisionAfter.body, decisionBefore.body);
  assert.deepEqual(appealAfter.body, appealBefore.body);

  // 恢复后仍可继续摄入，序号继续单调前进
  const resumed = await api(app.base, {
    method: "POST", path: "/v1/events", token: reviewer,
    body: {
      tenant_id: tenant, account_id: acct, event_id: "r-after", source_seq: 5,
      kind: "content_risk",
      payload: {content_id: "c-r2", risk_level: "low"},
    },
  });
  assert.equal(resumed.status, 201);
  assert.equal(resumed.body.status, "applied");

  await app.close();
  await pg.cleanup();
});
