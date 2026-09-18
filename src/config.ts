export type AppConfig = Readonly<{
  port: number;
  databaseUrl: string;
  /** [{tenant_id,key_id,secret,status?}] 启动时写入 signing_keys（已存在则跳过） */
  signingKeys: readonly SeedKey[];
  adminToken: string;
  maxClockSkewSeconds: number;
  /** 仅供演练：请求头 x-fault: abort 触发事务内回滚 */
  allowFaultInjection: boolean;
  migrationsDir: string;
}>;

export type SeedKey = Readonly<{
  tenant_id: string;
  key_id: string;
  secret: string;
  status?: "active" | "retired";
  roles?: ReadonlyArray<"guardian" | "reviewer" | "auditor">;
  subject?: string;
}>;

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  let signingKeys: SeedKey[] = [];
  const raw = process.env.SIGNING_KEYS;
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("SIGNING_KEYS 必须是 JSON 数组");
    signingKeys = parsed as SeedKey[];
  }
  return {
    port: Number(env("PORT", "8080")),
    databaseUrl: env("DATABASE_URL", "postgresql://minor_policy:minor_policy@localhost:5439/minor_policy"),
    signingKeys,
    adminToken: env("ADMIN_TOKEN", "dev-admin-token"),
    maxClockSkewSeconds: Number(env("MAX_CLOCK_SKEW_SECONDS", "300")),
    allowFaultInjection: process.env.ALLOW_FAULT_INJECTION === "true",
    migrationsDir: env("MIGRATIONS_DIR", new URL("../migrations", import.meta.url).pathname),
  };
}
