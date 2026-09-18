import {readFile, readdir} from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type {Pool, PoolClient, QueryResult, QueryResultRow} from "pg";

const {Pool: PgPool} = pg;

export type Db = {
  pool: Pool;
  /** 在事务中执行；遇序列化失败/死锁自动有限次重试 */
  withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  query<TRow extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<TRow>>;
  close(): Promise<void>;
};

const RETRYABLE_SQLSTATE = new Set(["40001", "40P01"]);

export function createDb(databaseUrl: string): Db {
  const pool = new PgPool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return {
    pool,
    async withTransaction(fn) {
      let attempt = 0;
      for (;;) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          const sqlstate = (error as {code?: string}).code;
          if (sqlstate && RETRYABLE_SQLSTATE.has(sqlstate) && attempt < 3) {
            attempt += 1;
            continue;
          }
          throw error;
        } finally {
          client.release();
        }
      }
    },
    query: (text, params) => pool.query(text, params as unknown[]),
    close: () => pool.end(),
  };
}

/** 顺序执行 migrations 目录下的 *.sql，已在 schema_migrations 记录的版本跳过 */
export async function runMigrations(db: Db, migrationsDir: string): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const version = file;
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await db.withTransaction(async (client) => {
      const applied = await client.query<{version: string}>(
        "SELECT version FROM schema_migrations WHERE version = $1",
        [version],
      );
      if (applied.rowCount! > 0) return;
      await client.query(sql);
    });
    console.log(`迁移已应用：${version}`);
  }
}

/** 账号级事务咨询锁：同一账号并发事件全局串行（只允许一个当前投影写入者） */
export async function lockAccount(client: PoolClient, tenantId: string, accountId: string): Promise<void> {
  // 双键形式：tenant、account 各自哈希成 int4，避免拼接分隔符碰撞
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    [tenantId, accountId],
  );
}

export async function seedKeys(
  db: Db,
  keys: readonly {
    tenant_id: string;
    key_id: string;
    secret: string;
    status?: "active" | "retired";
    roles?: ReadonlyArray<"guardian" | "reviewer" | "auditor">;
    subject?: string;
  }[],
): Promise<void> {
  for (const key of keys) {
    await db.query(
      `INSERT INTO signing_keys (tenant_id, key_id, secret, status, roles, subject)
       VALUES ($1, $2, $3, COALESCE($4, 'active'), $5::jsonb, $6)
       ON CONFLICT (tenant_id, key_id) DO NOTHING`,
      [
        key.tenant_id,
        key.key_id,
        key.secret,
        key.status ?? "active",
        JSON.stringify(key.roles ?? ["guardian", "reviewer", "auditor"]),
        key.subject ?? null,
      ],
    );
  }
}

/** 密钥轮换：旧 key 置 retired（仍可验签），新 key 置 active */
export async function rotateKey(
  db: Db,
  tenantId: string,
  oldKeyId: string,
  newKey: {key_id: string; secret: string},
): Promise<void> {
  await db.withTransaction(async (client) => {
    await client.query(
      "UPDATE signing_keys SET status = 'retired', retired_at = now() WHERE tenant_id = $1 AND key_id = $2",
      [tenantId, oldKeyId],
    );
    await client.query(
      "INSERT INTO signing_keys (tenant_id, key_id, secret, status) VALUES ($1, $2, $3, 'active')",
      [tenantId, newKey.key_id, newKey.secret],
    );
  });
}
