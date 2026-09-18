import {createDb, runMigrations, seedKeys} from "./db.js";
import {loadConfig} from "./config.js";

/** 一次性迁移任务：compose 中 app 通过 depends_on(successful) 等待它完成 */
async function migrate(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  for (let i = 0; i < 60; i++) {
    try {
      await db.query("SELECT 1");
      break;
    } catch (error) {
      console.log(`等待数据库（${i + 1}/60）：${(error as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await runMigrations(db, config.migrationsDir);
  await seedKeys(db, config.signingKeys);
  await db.close();
  console.log("迁移完成");
}

migrate().catch((error) => {
  console.error("迁移失败：", error);
  process.exit(1);
});
