import {createApp} from "./app.js";
import {loadConfig} from "./config.js";
import {createPool, waitForDatabase, waitForSchema} from "./db.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  // compose 已用探活与 migrate 服务编排启动顺序，这里再兜底数据库重启等场景
  await waitForDatabase(pool, config.dbConnectTimeoutMs);
  await waitForSchema(pool, config.schemaVersion, config.dbConnectTimeoutMs);

  const server = createApp(config, pool);
  await new Promise<void>((resolve) => {
    server.listen(config.port, "0.0.0.0", () => resolve());
  });
  console.log(JSON.stringify({msg: "listening", port: config.port}));

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(JSON.stringify({msg: "shutting_down", signal}));
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    // 兜底：连接排空超时后强制退出
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("服务启动失败:", err);
  process.exit(1);
});
