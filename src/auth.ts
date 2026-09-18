import crypto from "node:crypto";
import type {Pool} from "pg";
import type {Role} from "./domain/types.js";

export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export type Principal = Readonly<{
  tenantId: string;
  keyId: string;
  role: Role;
  subject: string | null;
  writeAllowed: boolean;
}>;

type KeyRow = {
  tenant_id: string;
  secret: string;
  status: "active" | "retired";
  roles: Role[];
  subject: string | null;
};

type SignatureParams = {
  keyId: string;
  tenant: string;
  role: Role;
  subject: string | null;
  ts: string;
  sig: string;
};

/** 供调用方/测试构造签名的规范化串（与验签端完全一致） */
export function canonicalString(input: {
  method: string;
  pathname: string;
  tenant: string;
  keyId: string;
  role: string;
  ts: string;
  bodyHashHex: string;
}): string {
  return [
    input.method.toUpperCase(),
    input.pathname,
    input.tenant,
    input.keyId,
    input.role,
    input.ts,
    input.bodyHashHex,
  ].join("\n");
}

export function signCanonical(secret: string, canonical: string): string {
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

export function bodyHash(rawBody: Buffer): string {
  return crypto.createHash("sha256").update(rawBody).digest("hex");
}

/** 生成 Authorization 头（供测试与调用方使用） */
export function buildAuthHeader(input: {
  method: string;
  pathname: string;
  tenant: string;
  keyId: string;
  secret: string;
  role: Role;
  subject?: string | null;
  ts?: number;
  rawBody: Buffer;
}): string {
  const ts = String(input.ts ?? Math.floor(Date.now() / 1000));
  const subject = input.subject ?? "";
  const canonical = canonicalString({
    method: input.method,
    pathname: input.pathname,
    tenant: input.tenant,
    keyId: input.keyId,
    role: input.role,
    ts,
    bodyHashHex: bodyHash(input.rawBody),
  });
  const sig = signCanonical(input.secret, canonical);
  const params =
    `keyId="${input.keyId}",tenant="${input.tenant}",role="${input.role}",` +
    `subject="${subject}",ts="${ts}",sig="${sig}"`;
  return `HMAC-SHA256 ${params}`;
}

function parseAuthHeader(header: string | undefined): SignatureParams {
  if (!header || !header.startsWith("HMAC-SHA256 ")) {
    throw new AuthError(401, "缺少 HMAC-SHA256 签名");
  }
  const params = new Map<string, string>();
  const rest = header.slice("HMAC-SHA256 ".length);
  for (const match of rest.matchAll(/(\w+)="([^"]*)"(?:,|$)/g)) {
    params.set(match[1]!, match[2]!);
  }
  const keyId = params.get("keyId");
  const tenant = params.get("tenant");
  const role = params.get("role") as Role | undefined;
  const ts = params.get("ts");
  const sig = params.get("sig");
  if (!keyId || !tenant || !role || !ts || !sig) {
    throw new AuthError(401, "签名参数不完整");
  }
  if (!["guardian", "reviewer", "auditor"].includes(role)) {
    throw new AuthError(403, `未知角色：${role}`);
  }
  return {keyId, tenant, role, subject: params.get("subject") || null, ts, sig};
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 验签并返回调用方身份：
 *  - key 按 (header.tenant, key_id) 查询 => 天然只能读自身租户；
 *  - 轮换后 retired key 仍可验签（读取历史决定），但写入必须用 active key；
 *  - auditor 只读；POST 仅 guardian/reviewer。
 */
export async function authenticate(
  pool: Pool,
  request: {method: string; url: string; headers: Record<string, string | undefined>},
  rawBody: Buffer,
  options: {maxClockSkewSeconds: number},
): Promise<Principal> {
  const parsed = parseAuthHeader(request.headers["authorization"]);

  const result = await pool.query<KeyRow>(
    "SELECT tenant_id, secret, status, roles, subject FROM signing_keys WHERE tenant_id = $1 AND key_id = $2",
    [parsed.tenant, parsed.keyId],
  );
  const key = result.rows[0];
  if (!key) {
    throw new AuthError(401, "密钥不存在或不属于该租户");
  }

  const pathname = new URL(request.url!, "http://localhost").pathname;
  const canonical = canonicalString({
    method: request.method,
    pathname,
    tenant: parsed.tenant,
    keyId: parsed.keyId,
    role: parsed.role,
    ts: parsed.ts,
    bodyHashHex: bodyHash(rawBody),
  });
  const expected = signCanonical(key.secret, canonical);
  if (!timingSafeEqualHex(expected, parsed.sig)) {
    throw new AuthError(401, "签名校验失败");
  }

  const ts = Number(parsed.ts);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > options.maxClockSkewSeconds) {
    throw new AuthError(401, "签名时间戳超出允许偏差");
  }

  if (!key.roles.includes(parsed.role)) {
    throw new AuthError(403, `密钥 ${parsed.keyId} 未授予角色 ${parsed.role}`);
  }

  const isWrite = request.method !== "GET";
  if (isWrite && key.status === "retired") {
    throw new AuthError(403, "密钥已轮换退役，不能用于写入，请使用新 key");
  }
  if (isWrite && parsed.role === "auditor") {
    throw new AuthError(403, "审计员为只读身份");
  }

  return {
    tenantId: key.tenant_id,
    keyId: parsed.keyId,
    role: parsed.role,
    // 以服务端登记的 subject 为准（按监护人发放的密钥无法冒名查看他人授权明细）；
    // 未登记 subject 的复核/审计共享密钥才退回签名中的声明（该值已被 HMAC 覆盖）
    subject: key.subject ?? parsed.subject,
    writeAllowed: !isWrite ? false : parsed.role !== "auditor",
  };
}

/** 路径中的 tenant_id 必须与签名身份租户一致，否则即越权 */
export function assertSameTenant(principal: Principal, pathTenantId: string): void {
  if (principal.tenantId !== pathTenantId) {
    throw new AuthError(403, "签名身份无权访问其他租户的数据");
  }
}
