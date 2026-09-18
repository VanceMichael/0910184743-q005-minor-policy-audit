import test from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import pg from "pg";
import {createTestCluster} from "./helpers/pg.mjs";
import {startTestApp, DEFAULT_KEYS} from "./helpers/app.mjs";

const {Client} = pg;
const clusterAvailable = Boolean(process.env.TEST_DATABASE_URL) || existsSync("/tmp/pg/bin/postgres");
const it = (name, fn) => test(name, {skip: clusterAvailable ? false : "需要 PostgreSQL（TEST_DATABASE_URL 或 /tmp/pg）"}, fn);

let cluster;
let app;
let app2Counter = 0;

test.before(async () => {
  if (!clusterAvailable) return;
  cluster = await createTestCluster();
  app = await startTestApp({appUrl: cluster.appUrl});
});

test.after(async () => {
  if (!clusterAvailable) return;
  await app.close();
  await cluster.destroy();
});

async function rawClient() {
  const client = new Client(cluster.appUrl);
  await client.connect();
  return client;
}

function accountPath(tenant, account, suffix = "") {
  return `/v1/tenants/${tenant}/accounts/${account}${suffix}`;
}

it("健康检查返回数据库就绪", async () => {
  const health = await app.health();
  assert.equal(health.status, 200);
  assert.equal(health.body.database, "up");
});

it("重复事件幂等：同一 event_id 返回相同决定 id，且不产生第二条审计", async () => {
  const t = "t-alpha", a = "acct-dup";
  const post = (eventId) =>
    app.client({method: "POST", pathname: accountPath(t, a, `/events/3/${eventId}`), body: {kind: "content_risk", payload: {content_id: "c1", action: "view", risk: "high"}}});
  // 先补齐 seq1 年龄证据，避免乱序
  await app.client({method: "POST", pathname: accountPath(t, a, "/events/1/age1"), body: {kind: "age_evidence", payload: {age_band: "under_13"}}});
  const first = await post("content-1");
  const second = await post("content-1");
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "applied");
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.status, "duplicate");
  assert.equal(second.body.decision.id, first.body.decision.id);
  const decisions = await app.client({pathname: accountPath(t, a, "/decisions"), role: "auditor"});
  assert.equal(decisions.body.items.length, 1);
});

it("乱序/迟到事件：留存可查询，但投影不回退", async () => {
  const t = "t-alpha", a = "acct-order";
  const P = (suffix) => accountPath(t, a, suffix);
  await app.client({method: "POST", pathname: P("/events/1/age-a"), body: {kind: "age_evidence", payload: {age_band: "16_to_17"}}});
  const seq3 = await app.client({method: "POST", pathname: P("/events/3/content-3"), body: {kind: "content_risk", payload: {content_id: "c3", action: "view", risk: "high"}}});
  assert.equal(seq3.body.projectionRevision, 3);
  const late = await app.client({method: "POST", pathname: P("/events/2/guard-late"), body: {kind: "guardian_authorization", payload: {guardian_id: "g-late", action: "grant"}}});
  assert.equal(late.body.status, "late");
  assert.equal(late.body.applied, false);
  // 旧序号事实仍可按 seq 查询
  const oldEvent = await app.client({pathname: P("/events/2")});
  assert.equal(oldEvent.status, 200);
  assert.equal(oldEvent.body.event_id, "guard-late");
  assert.equal(oldEvent.body.applied, false);
  // 投影 revision 停在 3，年龄不被覆盖，监护关系不被追溯应用
  const proj = await app.client({pathname: P("/projection")});
  assert.equal(proj.body.revision, 3);
  assert.equal(proj.body.age_band, "16_to_17");
  assert.deepEqual(proj.body.guardian_state, {guardians: {}});
  // 同序号不同 event_id 冲突
  const clash = await app.client({method: "POST", pathname: P("/events/2/other-id"), body: {kind: "age_evidence", payload: {age_band: "under_13"}}});
  assert.equal(clash.status, 409);
});

it("越权：签名身份只能访问自身租户", async () => {
  // t-beta 的 key 试图访问 t-alpha 的账号
  const denied = await app.client({keyId: "k-beta-1", pathname: accountPath("t-alpha", "acct-order", "/projection")});
  assert.equal(denied.status, 403);
  // 反向同样禁止
  const denied2 = await app.client({keyId: "k-alpha-1", pathname: accountPath("t-beta", "whatever", "/projection")});
  assert.equal(denied2.status, 403);
  // 签名租户与 key 不匹配（伪造 tenant）→ 查不到 key
  // （客户端用 k-beta-1 的 secret，却把路径指向 t-alpha，已在上面被 assertSameTenant 拦截）
});

it("坏签名 / 缺失签名被拒", async () => {
  const t = "t-alpha", a = "acct-order";
  const noAuth = await fetch(`${app.base}${accountPath(t, a, "/projection")}`);
  assert.equal(noAuth.status, 401);
  const badAuth = await fetch(`${app.base}${accountPath(t, a, "/projection")}`, {
    headers: {authorization: 'HMAC-SHA256 keyId="k-alpha-1",tenant="t-alpha",role="reviewer",subject="",ts="1",sig="00"'},
  });
  assert.equal(badAuth.status, 401);
});

it("事务失败：故障注入整体回滚，重试后成功且时间线连续", async () => {
  const t = "t-alpha", a = "acct-fault";
  const P = (suffix) => accountPath(t, a, suffix);
  await app.client({method: "POST", pathname: P("/events/1/age-f"), body: {kind: "age_evidence", payload: {age_band: "under_13"}}});
  const aborted = await app.client({
    method: "POST", pathname: P("/events/2/content-f"),
    headers: {"x-fault": "abort"},
    body: {kind: "content_risk", payload: {content_id: "cf", action: "view", risk: "high"}},
  });
  assert.equal(aborted.status, 500);
  // 回滚后：事件与决定均不存在
  const ev2 = await app.client({pathname: P("/events/2")});
  assert.equal(ev2.status, 404);
  const projBefore = await app.client({pathname: P("/projection")});
  assert.equal(projBefore.body.revision, 1);
  // 同样的 event_id 可重新提交成功
  const retry = await app.client({method: "POST", pathname: P("/events/2/content-f"), body: {kind: "content_risk", payload: {content_id: "cf", action: "view", risk: "high"}}});
  assert.equal(retry.status, 200);
  assert.equal(retry.body.status, "applied");
  assert.equal(retry.body.projectionRevision, 2);
});

it("申诉结果引用其实际推翻/维持的决定", async () => {
  const t = "t-alpha", a = "acct-appeal";
  const P = (suffix) => accountPath(t, a, suffix);
  // 决定发生“当时”就存在监护人，误报复算才可能 allow
  await app.client({method: "POST", pathname: P("/events/1/age-ap"), body: {kind: "age_evidence", payload: {age_band: "under_13"}}});
  await app.client({method: "POST", pathname: P("/events/2/guard-ap"), body: {kind: "guardian_authorization", payload: {guardian_id: "g1", action: "grant"}}});
  const blocked = await app.client({method: "POST", pathname: P("/events/3/content-blocked"), body: {kind: "content_risk", payload: {content_id: "cb", action: "view", risk: "high"}}});
  assert.equal(blocked.body.decision.decision, "block");
  const targetId = blocked.body.decision.id;

  // 误报：按当时快照（under_13+生效监护）把风险纠正为 low => allow，推翻 block
  const appeal = await app.client({method: "POST", pathname: P("/events/4/appeal-1"), body: {kind: "appeal", payload: {target_content_event_id: "content-blocked", claim: "false_positive"}}});
  assert.equal(appeal.status, 200);
  assert.equal(appeal.body.appeal.result, "overturned");
  assert.equal(appeal.body.appeal.targetDecisionId, targetId);

  const appealRead = await app.client({pathname: P("/appeals/appeal-1"), role: "auditor"});
  assert.equal(appealRead.body.target_decision_id, targetId);
  assert.equal(appealRead.body.target_content_event_id, "content-blocked");
  assert.equal(appealRead.body.original_decision, "block");
  assert.equal(appealRead.body.reviewed_decision, "allow");

  // 维持场景：对一个 allow 的低风险决定申诉误报，结论一致
  const allowed = await app.client({method: "POST", pathname: P("/events/5/content-allowed"), body: {kind: "content_risk", payload: {content_id: "ca", action: "view", risk: "low"}}});
  assert.equal(allowed.body.decision.decision, "allow");
  const maintain = await app.client({method: "POST", pathname: P("/events/6/appeal-2"), body: {kind: "appeal", payload: {target_content_event_id: "content-allowed", claim: "false_positive"}}});
  assert.equal(maintain.body.appeal.result, "maintained");
  assert.equal(maintain.body.appeal.targetDecisionId, allowed.body.decision.id);

  // 申诉不存在的目标 → 422
  const ghost = await app.client({method: "POST", pathname: P("/events/7/appeal-ghost"), body: {kind: "appeal", payload: {target_content_event_id: "nope", claim: "false_positive"}}});
  assert.equal(ghost.status, 422);
});

it("密钥轮换：旧 key 只读不可写，历史决定保留原 key_id，新写入带新 key_id", async () => {
  const t = "t-rotate", a = "acct-rotate";
  const P = (suffix) => accountPath(t, a, suffix);
  await app.client({method: "POST", keyId: "k-rotate-1", pathname: P("/events/1/age-r"), body: {kind: "age_evidence", payload: {age_band: "16_to_17"}}});
  const before = await app.client({method: "POST", keyId: "k-rotate-1", pathname: P("/events/2/content-oldkey"), body: {kind: "content_risk", payload: {content_id: "ro", action: "view", risk: "low"}}});
  assert.equal(before.body.decision.policyVersion, "minor-safety-1");

  const rotated = await app.rotateKey({tenant_id: t, old_key_id: "k-rotate-1", new_key_id: "k-rotate-2", new_secret: "secret-rotate-2"});
  assert.equal(rotated.status, 200);

  const {createClient} = await import("./helpers/app.mjs");
  const client2 = createClient(app.base, [
    ...DEFAULT_KEYS,
    {tenant_id: t, key_id: "k-rotate-2", secret: "secret-rotate-2", roles: ["guardian", "reviewer", "auditor"]},
  ]);

  // 旧 key 写被拒，但仍可读
  const oldWrite = await client2({method: "POST", keyId: "k-rotate-1", pathname: P("/events/3/x"), body: {kind: "age_evidence", payload: {age_band: "under_13"}}});
  assert.equal(oldWrite.status, 403);
  const oldRead = await client2({keyId: "k-rotate-1", pathname: P("/decisions"), role: "auditor"});
  assert.equal(oldRead.status, 200);

  // 新 key 写入
  const newWrite = await client2({method: "POST", keyId: "k-rotate-2", pathname: P("/events/3/content-newkey"), body: {kind: "content_risk", payload: {content_id: "rn", action: "view", risk: "low"}}});
  assert.equal(newWrite.status, 200);

  const decisions = (await client2({keyId: "k-rotate-2", pathname: P("/decisions"), role: "auditor"})).body.items;
  const byEvent = Object.fromEntries(decisions.map((d) => [d.content_event_id, d.signing_key_id]));
  assert.equal(byEvent["content-oldkey"], "k-rotate-1");
  assert.equal(byEvent["content-newkey"], "k-rotate-2");
});

it("角色字段差异：监护人看不到风险类目/其他监护人明细/key_id，审计员可见全量", async () => {
  const t = "t-alpha", a = "acct-rbac";
  const P = (suffix) => accountPath(t, a, suffix);
  await app.client({method: "POST", pathname: P("/events/1/age-rb"), body: {kind: "age_evidence", payload: {age_band: "under_13"}}});
  await app.client({method: "POST", pathname: P("/events/2/guard-own"), role: "guardian", subject: "guardian-1", body: {kind: "guardian_authorization", payload: {guardian_id: "guardian-1", action: "grant", scope: "messages"}}});
  await app.client({method: "POST", pathname: P("/events/3/content-rb"), body: {kind: "content_risk", payload: {content_id: "crb", action: "message", risk: "high", categories: ["adult", "contact"]}}});

  const guardian = (await app.client({pathname: P("/decisions"), role: "guardian", subject: "guardian-1"})).body.items[0];
  assert.equal(guardian.decision, "block");
  assert.equal(guardian.signing_key_id, undefined);
  assert.equal(guardian.risk_snapshot, undefined);
  assert.equal(guardian.risk, "high");

  const auditor = (await app.client({pathname: P("/decisions"), role: "auditor"})).body.items[0];
  assert.deepEqual(auditor.risk_snapshot.categories, ["adult", "contact"]);
  assert.equal(auditor.signing_key_id, "k-alpha-1");
  assert.ok(auditor.guardian_snapshot.guardians["guardian-1"]);

  // 审计员只读
  const auditorWrite = await app.client({method: "POST", role: "auditor", pathname: P("/events/4/x"), body: {kind: "age_evidence", payload: {age_band: "under_13"}}});
  assert.equal(auditorWrite.status, 403);
});

it("不可变审计：数据库层拒绝 UPDATE/DELETE 事实与审计表", async () => {
  const client = await rawClient();
  const setColumn = {account_events: "note", content_decisions: "rationale", appeal_outcomes: "reason"};
  for (const table of ["account_events", "content_decisions", "appeal_outcomes"]) {
    await assert.rejects(() => client.query(`UPDATE ${table} SET ${setColumn[table]} = 'hacked' WHERE true`), /immutable table/);
    await assert.rejects(() => client.query(`DELETE FROM ${table} WHERE true`), /immutable table/);
  }
  await client.end();
});

it("投影 revision 不可在数据库层被回退", async () => {
  const client = await rawClient();
  await assert.rejects(
    () => client.query("UPDATE account_projection SET revision = revision - 1 WHERE account_id = 'acct-order'"),
    /revision cannot go backwards/,
  );
  await client.end();
});

it("数据库重启后时间线与重启前完全一致，并可继续追加", async () => {
  const t = "t-alpha", a = "acct-restart";
  const P = (suffix) => accountPath(t, a, suffix);
  // 重启前建立时间线，序号在 4 处留空（模拟来源端丢事件），revision 推进到 5
  await app.client({method: "POST", pathname: P("/events/1/age-rs"), body: {kind: "age_evidence", payload: {age_band: "13_to_15"}}});
  await app.client({method: "POST", pathname: P("/events/2/guard-rs"), body: {kind: "guardian_authorization", payload: {guardian_id: "grs", action: "grant"}}});
  await app.client({method: "POST", pathname: P("/events/3/content-rs"), body: {kind: "content_risk", payload: {content_id: "crs", action: "view", risk: "medium"}}});
  await app.client({method: "POST", pathname: P("/events/5/age-rs-5"), body: {kind: "age_evidence", payload: {age_band: "16_to_17"}}});

  const snapshot = {
    projection: (await app.client({pathname: P("/projection"), role: "auditor"})).body,
    events: (await app.client({pathname: P("/events"), role: "auditor"})).body.items,
    decisions: (await app.client({pathname: P("/decisions"), role: "auditor"})).body.items,
  };

  // 关闭应用连接 → 崩溃式停库（同数据目录）→ 重启 → 新应用重连
  await app.close();
  if (cluster.managed) {
    await cluster.restart("immediate");
  }
  const appRestarted = await startTestApp({appUrl: cluster.appUrl});
  app2Counter += 1;

  try {
    const after = {
      projection: (await appRestarted.client({pathname: P("/projection"), role: "auditor"})).body,
      events: (await appRestarted.client({pathname: P("/events"), role: "auditor"})).body.items,
      decisions: (await appRestarted.client({pathname: P("/decisions"), role: "auditor"})).body.items,
    };
    assert.equal(after.projection.revision, snapshot.projection.revision);
    assert.equal(after.projection.age_band, snapshot.projection.age_band);
    assert.equal(after.projection.latest_decision, snapshot.projection.latest_decision);
    assert.equal(after.events.length, snapshot.events.length);
    assert.deepEqual(
      after.events.map((e) => [e.event_id, e.source_seq, e.applied]),
      snapshot.events.map((e) => [e.event_id, e.source_seq, e.applied]),
    );
    assert.deepEqual(
      after.decisions.map((d) => [d.content_event_id, d.decision, d.policy_version, d.signing_key_id]),
      snapshot.decisions.map((d) => [d.content_event_id, d.decision, d.policy_version, d.signing_key_id]),
    );

    // 重启后继续追加：序号严格接在 revision(=5) 之后；空号 seq4 补达记为 late，不回退
    const cont = await appRestarted.client({method: "POST", pathname: P("/events/6/post-restart"), body: {kind: "content_risk", payload: {content_id: "c6", action: "view", risk: "low"}}});
    assert.equal(cont.body.projectionRevision, 6);
    const stale = await appRestarted.client({method: "POST", pathname: P("/events/4/dup-old"), body: {kind: "age_evidence", payload: {age_band: "under_13"}}});
    assert.equal(stale.body.status, "late");
    assert.equal(stale.body.applied, false);
    assert.equal(stale.body.projectionRevision, 6);

    // 重启后新增申诉，引用重启前的决定
    const appeal = await appRestarted.client({method: "POST", pathname: P("/events/7/appeal-post-restart"), body: {kind: "appeal", payload: {target_content_event_id: "content-rs", claim: "false_positive"}}});
    assert.ok(appeal.body.appeal.targetDecisionId > 0);
    const appeals = (await appRestarted.client({pathname: P("/appeals"), role: "auditor"})).body.items;
    assert.equal(appeals.at(-1).target_content_event_id, "content-rs");
  } finally {
    await appRestarted.close();
    // 为后续测试重新拉起默认 app
    app = await startTestApp({appUrl: cluster.appUrl});
  }
});
