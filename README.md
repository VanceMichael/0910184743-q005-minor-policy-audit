# 未成年人策略判定审计服务

纯后端策略判定服务（Node.js 22 + TypeScript + PostgreSQL 16）。面向安全运营的未成年人账号申诉场景：
按 `tenant_id / account_id / source_seq / event_id` 接收**脱敏**的年龄证明、监护授权、内容风险与申诉事件，
在**同一事务**内完成幂等落库、单调版本检查、策略决策与不可变审计，使任意一次内容动作当时使用的
年龄段、监护关系与策略版本都可以被完整还原。

## 快速开始

```bash
# 本地（需要可访问的 PostgreSQL 16，连接串由环境注入）
npm ci
npm run build
DATABASE_URL=postgresql://minor_policy:minor_policy@localhost:5432/minor_policy npm run migrate
DATABASE_URL=postgresql://minor_policy:minor_policy@localhost:5432/minor_policy npm start

# Docker Compose（编排迁移、应用、数据库探活与持久卷）
docker compose up --build
```

应用探活 `GET /health`，就绪检查 `GET /ready`。数据库连接只通过 `DATABASE_URL` 注入，不写入仓库。

## 架构与一致性设计

- **单事务摄入**：`POST /v1/events` 在一个事务里依次完成
  1. 幂等落库——`(tenant_id, event_id)` 唯一约束 + `ON CONFLICT`，重复投递返回首次决定（`status: "duplicate"`）；
  2. 单调版本检查——投影行 `SELECT ... FOR UPDATE` 串行化同一账号的并发摄入，
     仅当 `source_seq > last_applied_seq` 才并入投影，旧序号事件记为 `stale`（可查询、绝不回退状态）；
     `policy_version` 同样只升不降，迟到的旧策略事件不会撤销更严格的新限制；
  3. 策略决策——按（年龄段 × 风险级别）矩阵 + 监护覆盖评估，年龄证据缺失时按最严格档并标注原因；
  4. 不可变审计——`decisions` 表由触发器禁止 UPDATE/DELETE，逐账号 `prev_hash → decision_hash`
     哈希链防篡改，`key_id` 记录决定当时的签名密钥。
- **唯一当前投影**：`account_projection` 以 `(tenant_id, account_id)` 为主键，每账号恰好一行；
  行锁保证并发下只有一个投影被推进。
- **申诉引用**：申诉记录 `target_decision_id`（被推翻或维持的原决定）与 `resolution_decision_id`
  （解决决定）；`GET /v1/appeals/{id}` 返回 `overturned_decision_id` / `upheld_decision_id`。
  推翻仅在当前限制确实源自该决定时解除限制（前向生效，不回退）。
- **重启一致**：全部状态在 PostgreSQL（命名卷 `minor-policy-data`），数据库重启恢复后
  `GET .../timeline` 与重启前逐字节一致。

## 认证与多租户

调用方携带签名身份（HMAC-SHA256 令牌 `mp1.<header>.<payload>.<signature>`，header 含 `kid`）。
先用引导密钥换取令牌（引导密钥由 `BOOTSTRAP_SECRET` 注入，默认 `dev-bootstrap-secret` 仅供本地）：

```bash
curl -X POST localhost:8080/v1/auth/token -H 'content-type: application/json' -d '{
  "tenant_id": "tenant-demo", "subject": "ops-1", "role": "reviewer", "secret": "dev-bootstrap-secret"
}'
```

之后所有请求带 `Authorization: Bearer <token>`。**令牌只能读写自身租户**：事件体租户与令牌租户
不一致返回 403，跨租户读取返回 404。密钥轮换 `POST /v1/auth/rotate`（reviewer/auditor）：
旧密钥转为 retired 继续验签，新决定使用新 `key_id`，**历史决定仍显示原 key_id**。

## 角色字段矩阵

同一资源按角色返回不同字段：

| 资源 | guardian | reviewer | auditor |
| --- | --- | --- | --- |
| decision | id, account_id, kind, outcome, reason_code, created_at | + event_id, source_seq, applied, age_band, guardianship_status, policy_version, risk_level | + tenant_id, decision_seq, **key_id**, payload_hash, prev_hash, decision_hash |
| projection | account_id, restriction_level, guardianship_status, updated_at | + age_band, policy_version, last_applied_seq, projection_revision, … | + tenant_id, age_attestation_id, guardian_id, decision_count, last_decision_hash |
| event | source_seq, kind, status, received_at | + event_id, occurred_at, payload | + id, tenant_id, account_id, payload_hash |
| appeal | appeal_id, account_id, status, reason, opened_at, resolved_at, overturned/upheld_decision_id | + event_id, target/resolution_decision_id, resolver | + tenant_id, resolution_note |

## API 一览

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` `/ready` | 公开 | 探活 / 就绪 |
| POST | `/v1/auth/token` | 公开（引导密钥） | 签发令牌 |
| POST | `/v1/auth/rotate` | reviewer, auditor | 轮换签名密钥 |
| POST | `/v1/events` | 全部 | 摄入事件（幂等、单调、决策、审计同事务） |
| GET | `/v1/accounts/{id}/projection` | 全部 | 唯一当前投影 |
| GET | `/v1/accounts/{id}/timeline` | 全部 | 事件+决定+申诉时间线 |
| GET | `/v1/decisions/{id}` | 全部 | 单个决定（按角色裁剪） |
| GET | `/v1/appeals/{id}` | 全部 | 申诉及其推翻/维持的决定 |
| POST | `/v1/appeals/{id}/resolve` | reviewer | 解决申诉 `{outcome: overturn\|uphold}` |
| GET/POST | `/v1/policies` | 读全部 / 写 reviewer | 策略版本列表 / 发布（版本号必须单调递增） |

### 事件信封

```json
{
  "tenant_id": "tenant-demo", "account_id": "account-a",
  "source_seq": 3, "event_id": "evt-3",
  "kind": "content_risk",
  "policy_version": 2,
  "payload": {"content_id": "c-9", "risk_level": "high", "categories": ["violence"]}
}
```

`kind ∈ age_evidence | guardianship | content_risk | appeal`；负载样例见 `fixtures/events.json`。
`policy_version` 省略时使用租户当前最新版本；指定不存在的版本返回 422 并整体回滚。

### 处置结果与策略

处置 `outcome ∈ allow | limit | block | review`（见 `contracts/policy.json`）。默认随租户供应
`minor-safety-1`（v1）与更严格的 `minor-safety-2`（v2，收紧 medium/high、取消监护覆盖）。
限制级别：allow=0，limit/review=1，block=2。

## 验收场景对照

| 场景 | 行为 |
| --- | --- |
| 重复投递 | 同 `event_id` 重放返回首次决定，`status: "duplicate"`；负载不同的复用返回 409 |
| 乱序事件 | 旧 `source_seq` 记为 `stale` 并入审计链，投影不回退；时间线仍可查询 |
| 越权访问 | 无令牌/签名错误 401；跨租户写 403、读 404；角色不符 403 |
| 事务失败 | 负载非法 400、引用缺失 422、序号冲突 409——全部整体回滚，无部分写入 |
| 数据库重启 | 命名卷持久化；恢复后时间线与重启前一致；应用自动重连 |
| 密钥轮换 | 历史决定保持原 `key_id`，新决定使用新密钥，旧令牌在过期前可验签 |

## 测试

```bash
npm test          # 单元 + 集成（embedded-postgres 拉起真实 PG 16）+ 重启一致性
```

`test/integration.test.js` 覆盖重复、乱序、越权、事务失败、并发单投影、密钥轮换与申诉引用；
`test/restart.test.js` 验证数据库重启后时间线逐字节一致。
