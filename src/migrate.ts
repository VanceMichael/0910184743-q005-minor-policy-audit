import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {loadConfig} from "./config.js";
import {createPool, waitForDatabase, type Pool} from "./db.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * 迁移 runner：按文件名顺序应用 migrations/*.sql，逐迁移单事务落库并记录版本。
 * 作为 compose 中的一次性服务运行（应用等待其成功退出后才启动），可重复执行。
 */
export async function runMigrations(pool: Pool, migrationsDir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const appliedVersions: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (applied.rowCount === 1) {
        await client.query("COMMIT");
        continue;
      }
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      appliedVersions.push(version);
      console.log(JSON.stringify({msg: "migration_applied", version}));
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  return appliedVersions;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  waitForDatabase(pool, config.dbConnectTimeoutMs)
    .then(() => runMigrations(pool))
    .then((applied) => {
      console.log(JSON.stringify({msg: "migrations_complete", applied}));
    })
    .catch((err: unknown) => {
      console.error("迁移失败:", err);
      process.exitCode = 1;
    })
    .finally(() => {
      void pool.end();
    });
}
