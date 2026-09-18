import pg from "pg";
import {conflict, HttpError, unprocessable} from "./errors.js";

const {Pool} = pg;
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    // 数据库重启后让空闲连接快速重建，而不是长时间挂起
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
  });
}

/** 单事务执行：摄入、申诉解决、密钥轮换都经此提交或整体回滚。 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 启动等待数据库可连接（compose 中依赖探活，这里再兜底重启场景）。 */
export async function waitForDatabase(pool: Pool, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }
  throw new Error(`等待数据库超时: ${String(lastError)}`);
}

/** 等待 migrate 服务把指定迁移落库，避免应用在空库上启动。 */
export async function waitForSchema(pool: Pool, version: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (result.rowCount === 1) return;
    } catch {
      // schema_migrations 尚不存在：migrate 服务还没跑完
    }
    await sleep(500);
  }
  throw new Error(`等待迁移版本 ${version} 超时`);
}

/** 唯一约束名 → 业务冲突码，由摄入管线映射为 409。 */
export const CONSTRAINT_ERROR_CODES: Readonly<Record<string, string>> = {
  uq_events_event_id: "event_id_conflict",
  uq_events_source_seq: "source_seq_conflict",
  uq_appeals_event: "appeal_event_conflict",
  pk_appeals: "appeal_id_conflict",
  pk_policies: "policy_version_conflict",
};

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

export function isPgError(err: unknown): err is PgErrorLike {
  return typeof err === "object" && err !== null && "code" in err;
}

/** 把 PostgreSQL 错误翻译成 HTTP 错误；未知错误原样抛出。 */
export function mapPgError(err: unknown): HttpError | null {
  if (!isPgError(err)) return null;
  if (err.code === "23505") {
    const code = (err.constraint && CONSTRAINT_ERROR_CODES[err.constraint]) || "unique_violation";
    return conflict(code, `唯一约束冲突: ${err.constraint ?? "unknown"}`);
  }
  if (err.code === "23503") {
    return unprocessable("foreign_key_violation", `引用不存在: ${err.constraint ?? "unknown"}`);
  }
  if (err.code === "23514" || err.code === "23502") {
    return unprocessable("constraint_violation", err.message ?? "约束校验失败");
  }
  if (err.message?.startsWith("immutable_table:")) {
    return conflict("immutable_audit_record", err.message);
  }
  return null;
}
