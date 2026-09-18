# 未成年人策略判定与不可变审计服务

纯后端服务：接收**脱敏**的年龄证明、监护授权、内容风险与申诉事件，在**同一事务**内完成
幂等落库、单调版本检查、策略决策与不可变审计；并保留每次内容动作**当时**使用的
年龄段、监护关系、策略版本与签名 `key_id`，使任何历史处置都可被还原和解释。

- 运行时：Node.js 22 + TypeScript（ESM，strict）
- 存储：PostgreSQL 16
- 无任何 Web 框架，仅依赖 `pg`

## 为什么不能只存最终处置

- **可解释误拦**：每条 `content_decisions` 都快照决定当时的 `age_band / age_band_known /
  guardian_snapshot / risk_snapshot / policy_version`，事后可按当时输入与旧版规则复盘。
- **晚到事件不得放松新限制**：序号落后于当前投影的事件只作事实留存（`applied=false`），
  旧序号可查询，但投影 `revision` 只进不退，迟到的授权/年龄证据不会追溯撤销更严格的新限制。
- **申诉必须引用真实决定**：`appeal_outcomes.target_decision_id` 外键指向被推翻或维持的
  那条不可变决定，并同时记录 `original_decision` 与 `reviewed_decision`。

## 数据模型（见 `migrations/001_initial.sql`）

| 表 | 作用 | 不变性 |
| --- | --- | --- |
| `account_events` | 只追加的事实事件流；`event_id` 全局幂等，`(tenant,account,source_seq)` 唯一 | 触发器禁止 UPDATE/DELETE |
| `account_projection` | 每账号唯一的当前投影；`revision` 单调（触发器禁止下降） | 仅可前进 |
| `content_decisions` | 每次内容动作的决定快照（年龄段/监护/风险/策略版本/key_id） | 触发器禁止 UPDATE/DELETE |
| `appeal_outcomes` | 申诉结果，外键引用被推翻/维持的决定 | 触发器禁止 UPDATE/DELETE |
| `signing_keys` | 每租户多把签名密钥；轮换后旧 key 置 `retired` 仍可验签读取 | — |

并发处理同一账号时，事务先取账号级 `pg_advisory_xact_lock` 并对投影行 `SELECT … FOR UPDATE`，
因此**同一账号全局串行，只有一个当前投影写入者**；不同账号互不阻塞。

## 事件入口（四要素都在路径上）

```
POST /v1/tenants/:tenant_id/accounts/:account_id/events/:source_seq/:event_id
```

请求体只描述事件类型与脱敏载荷：

```jsonc
// age_evidence（只存年龄段，不存生日）
{"kind":"age_evidence","payload":{"age_band":"under_13","confidence":"high"}}
// guardian_authorization
{"kind":"guardian_authorization","payload":{"guardian_id":"g-1","action":"grant","scope":"messages"}}
// content_risk
{"kind":"content_risk","payload":{"content_id":"post-1","action":"message","risk":"high","categories":["contact"]}}
// appeal（引用历史内容事件）
{"kind":"appeal","payload":{"target_content_event_id":"evt-content-1","claim":"false_positive"}}
```

响应：

```json
{"event_id":"evt-content-1","idempotent":false,"applied":true,"status":"applied",
 "source_seq":3,"projectionRevision":3,
 "decision":{"id":1,"decision":"block","policyVersion":"minor-safety-1"},"note":null}
```

`status` 取值：`applied`（已推进投影）、`duplicate`（幂等命中，返回首次结果）、
`late`（乱序/迟到，事实留存但 `applied=false`，投影不回退）。

## 读模型（旧序号可查询）

```
GET /v1/tenants/:t/accounts/:a/projection            # 当前投影
GET /v1/tenants/:t/accounts/:a/events                # 全部事实（含 applied=false 的迟到事件）
GET /v1/tenants/:t/accounts/:a/events/:source_seq    # 按旧序号取事实
GET /v1/tenants/:t/accounts/:a/decisions             # 不可变决定列表
GET /v1/tenants/:t/accounts/:a/decisions/:event_id   # 某内容事件的决定快照
GET /v1/tenants/:t/accounts/:a/appeals               # 申诉结果（含 target_decision_id）
GET /v1/tenants/:t/accounts/:a/appeals/:event_id
GET /health                                           # 含数据库探活
```

## 策略（版本化，`src/domain/policy.ts`）

当前版本 `minor-safety-1`，规则矩阵按 `[年龄段][是否有生效监护人][风险等级]` 裁决
`allow / limit / block / review`；年龄段未知一律 `review`。升级策略时新增版本，
历史决定始终保留其当时的 `policy_version`，永不原地改规则。

申诉复核：
- `false_positive`：按**当时**年龄段/监护/策略版本，把风险纠正为 `low` 复算；
- `new_evidence`：按当前年龄段/监护关系、当前策略版本复算原风险；
- `procedural`：按当前策略版本重放当时输入。
结论与原决定不同即 `overturned`，否则 `maintained`。

## 签名鉴权、租户隔离与字段级角色

所有 `/v1` 请求都需要 HMAC-SHA256 签名头（密钥按 `(tenant,key_id)` 在库中查找）：

```
Authorization: HMAC-SHA256 keyId="...",tenant="...",role="reviewer",subject="...",ts="<unix>",sig="<hex>"
sig = HMAC_SHA256(secret, METHOD \n PATH \n tenant \n keyId \n role \n ts \n sha256(body))
```

- **租户隔离**：密钥按 `(tenant,key_id)` 查询，且路径租户必须等于签名租户，否则 `403`；
  签名身份只能读写自身租户。
- **密钥轮换**：`POST /admin/rotate-key`（`x-admin-token`）把旧 key 置 `retired`、写入新 key。
  旧 key **仍可验签读取**历史，但不能写入；历史决定行始终显示**原来的 `key_id`**。
- **角色最小可见性**：
  - `guardian`：决定结果、年龄段、理由、风险**等级**；看不到风险类目、其他监护人明细、`key_id`；
  - `reviewer`：复核所需全部脱敏快照（含 `key_id`），但其他监护人的授权 `scope` 被遮蔽；
  - `auditor`：只读全量审计字段（含快照、`key_id`、受理标志、时间戳），禁止写入。

可用 `src/auth.ts` 的 `buildAuthHeader(...)` 生成签名头（测试与调用方通用）。

## 本地运行

```bash
npm ci
npm test          # 编译 + 单元测试；检测到 PostgreSQL 时自动运行集成测试
```

针对真实 PostgreSQL 16 跑集成测试（含崩溃重启持久化）：

```bash
# 方式一：提供外部库
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test
# 方式二：提供本地 postgres 二进制目录（测试会自建/停启临时集群）
PG_BIN_DIR=/path/to/pg/bin npm test
```

启动服务：

```bash
DATABASE_URL=postgres://minor_policy:minor_policy@localhost:5432/minor_policy \
SIGNING_KEYS='[{"tenant_id":"tenant-demo","key_id":"k1","secret":"s1","roles":["guardian","reviewer","auditor"]}]' \
ADMIN_TOKEN=dev-admin-token \
npm start
```

## Docker Compose

编排了四个要素：**数据库探活**、**持久卷**、**一次性迁移任务**、**应用**。

```bash
docker compose config      # 校验编排
docker compose up --build  # migrate 成功后 app 才启动；postgres 健康后 migrate 才运行
```

- `postgres`：`pg_isready` 健康检查 + 命名卷 `minor-policy-data` + `restart: unless-stopped`；
- `migrate`：构建目标 `build`，执行 `node dist/migrate.js`，`restart: "no"`，
  `app` 通过 `service_completed_successfully` 依赖它；
- `app`：暴露 8080，自带 `/health` 容器健康检查，`restart: unless-stopped`。
  数据库重启后应用自动重连；由于状态全部落盘，恢复后的时间线与重启前一致，可继续追加。

## 已覆盖的验收场景（`test/`）

重复（幂等返回同一决定 id）、乱序/迟到（留存可查、投影不回退、同序号冲突 409）、
越权跨租户、坏签名、密钥轮换（旧 key 只读、历史保留原 `key_id`）、三角色字段差异、
故障注入事务整体回滚后可重提、审计表与投影 revision 在数据库层不可篡改、
以及**崩溃式停库并用同一数据目录重启后时间线完全一致并可继续追加与申诉**。
