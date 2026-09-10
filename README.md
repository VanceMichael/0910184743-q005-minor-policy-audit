# 未成年人策略判定审计

该服务接收脱敏的账号证据、内容风险和申诉事件。Node.js 22 应用使用 PostgreSQL 16 保存事件、当前投影与审计记录，策略样例位于 `contracts`。

```bash
npm test
docker compose config
docker compose build
docker compose up
```

数据库连接由 `DATABASE_URL` 注入，不应写入仓库。应用探活地址为 `GET /health`。
