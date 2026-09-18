import {base64UrlDecode, base64UrlEncode, hmacEqual, hmacSha256Hex, randomKeySecret} from "./cryptoUtil.js";
import {unauthorized} from "./errors.js";

/** 与 contracts/policy.json 对齐的三类调用方角色。 */
export const ROLES = ["guardian", "reviewer", "auditor"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export type TokenPayload = Readonly<{
  tenant_id: string;
  sub: string;
  role: Role;
  iat: number;
  exp: number;
  jti: string;
}>;

export type Actor = Readonly<{
  tenantId: string;
  subject: string;
  role: Role;
  keyId: string;
}>;

const TOKEN_PREFIX = "mp1";

/** 签发令牌：mp1.<header>.<payload>.<hmac>，header 携带 kid 支持轮换。 */
export function signToken(secret: string, keyId: string, payload: TokenPayload): string {
  const header = base64UrlEncode(JSON.stringify({alg: "HS256", typ: "MPWT", kid: keyId}));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = hmacSha256Hex(secret, `${TOKEN_PREFIX}.${header}.${body}`);
  return `${TOKEN_PREFIX}.${header}.${body}.${signature}`;
}

export type VerifiedToken = Readonly<{keyId: string; payload: TokenPayload}>;

/**
 * 校验令牌签名与有效期。secret 由调用方按 (tenant_id, kid) 从 auth_keys 取出；
 * 轮换后 retired 密钥仍可验签，历史令牌在过期前继续有效。
 */
export function verifyToken(token: string, secret: string, nowSeconds: number): VerifiedToken {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) {
    throw unauthorized("token_malformed", "令牌格式应为 mp1.<header>.<payload>.<signature>");
  }
  const [, headerPart, payloadPart, signature] = parts as [string, string, string, string];
  const expected = hmacSha256Hex(secret, `${TOKEN_PREFIX}.${headerPart}.${payloadPart}`);
  if (!hmacEqual(expected, signature)) {
    throw unauthorized("token_signature_invalid", "令牌签名不匹配");
  }
  let header: {kid?: unknown};
  let payload: Partial<TokenPayload>;
  try {
    header = JSON.parse(base64UrlDecode(headerPart)) as {kid?: unknown};
    payload = JSON.parse(base64UrlDecode(payloadPart)) as Partial<TokenPayload>;
  } catch {
    throw unauthorized("token_malformed", "令牌段不是合法 JSON");
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw unauthorized("token_kid_missing", "令牌头缺少 kid");
  }
  if (
    typeof payload.tenant_id !== "string" ||
    typeof payload.sub !== "string" ||
    !isRole(payload.role) ||
    typeof payload.exp !== "number"
  ) {
    throw unauthorized("token_payload_invalid", "令牌负载缺少必要字段");
  }
  if (payload.exp <= nowSeconds) {
    throw unauthorized("token_expired", "令牌已过期");
  }
  return {keyId: header.kid, payload: payload as TokenPayload};
}

export function newTokenPayload(tenantId: string, subject: string, role: Role, ttlSeconds: number): TokenPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    tenant_id: tenantId,
    sub: subject,
    role,
    iat: now,
    exp: now + ttlSeconds,
    jti: randomKeySecret().slice(0, 24),
  };
}
