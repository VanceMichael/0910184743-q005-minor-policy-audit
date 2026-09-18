import {createDb, runMigrations, seedKeys} from "./db.js";
import {loadConfig} from "./config.js";
import {startServer} from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  // 等待数据库就绪（容器/重启场景下 postgres 可能晚于应用启动）
  await waitForDatabase(db, 60, 1000);
  await runMigrations(db, config.migrationsDir);
  await seedKeys(db, config.signingKeys);

  const server = await startServer(config, db);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`收到 ${signal}，开始优雅关停`);
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

async function waitForDatabase(db: ReturnType<typeof createDb>, attempts: number, delayMs: number): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await db.query("SELECT 1");
      return;
    } catch (error) {
      console.log(`等待数据库就绪（${i + 1}/${attempts}）：${(error as Error).message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("数据库在限定时间内不可用");
}

main().catch((error) => {
  console.error("启动失败：", error);
  process.exit(1);
});
