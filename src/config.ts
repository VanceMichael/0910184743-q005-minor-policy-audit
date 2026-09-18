export type AppConfig = Readonly<{
  port: number;
  databaseUrl: string;
  bootstrapSecret: string;
  tokenTtlSeconds: number;
  /** 应用启动前必须由 migrate 服务落库的最新迁移版本 */
  schemaVersion: string;
  dbConnectTimeoutMs: number;
}>;

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`环境变量 ${name} 必须是正整数，当前为 ${JSON.stringify(raw)}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error("缺少 DATABASE_URL（数据库连接串只允许通过环境注入）");
  }
  return {
    port: parsePositiveInt(env.PORT, 8080, "PORT"),
    databaseUrl,
    bootstrapSecret: env.BOOTSTRAP_SECRET?.trim() || "dev-bootstrap-secret",
    tokenTtlSeconds: parsePositiveInt(env.TOKEN_TTL_SECONDS, 3600, "TOKEN_TTL_SECONDS"),
    schemaVersion: env.SCHEMA_VERSION?.trim() || "001_initial",
    dbConnectTimeoutMs: parsePositiveInt(env.DB_CONNECT_TIMEOUT_MS, 60_000, "DB_CONNECT_TIMEOUT_MS"),
  };
}
