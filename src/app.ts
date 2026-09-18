import http from "node:http";
import {isRole, verifyToken, type Actor, type Role} from "./auth.js";
import type {AppConfig} from "./config.js";
import {base64UrlDecode} from "./cryptoUtil.js";
import type {Pool} from "./db.js";
import {forbidden, notFound, unauthorized} from "./errors.js";
import {readJsonBody, sendError, sendJson} from "./httpUtil.js";
import {ingestEvent, mintToken, resolveAppeal, rotateKey} from "./ingest.js";
import {
  getAppealById,
  getDecisionById,
  getProjection,
  getTimeline,
  listPolicies,
  publishPolicy,
} from "./reads.js";
import {appealView, decisionView, eventView, projectionView} from "./serializers.js";
import {
  validateEventEnvelope,
  validatePolicyPublishRequest,
  validateResolveRequest,
  validateTokenRequest,
} from "./validation.js";

const ALL_ROLES: readonly Role[] = ["guardian", "reviewer", "auditor"];

type HandlerContext = Readonly<{
  actor: Actor;
  params: readonly string[];
  body: unknown;
}>;

type Handler = (ctx: HandlerContext) => Promise<{status: number; body: unknown}>;

interface Route {
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
  readonly roles: readonly Role[];
  readonly handler: Handler;
}

/** 从 Authorization 头解析并验签调用方身份；密钥按 (tenant_id, kid) 查找，轮换后旧钥仍可验签。 */
async function authenticate(pool: Pool, authorization: string | undefined): Promise<Actor> {
  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw unauthorized("missing_token", "缺少 Bearer 令牌");
  }
  const token = authorization.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length !== 4) throw unauthorized("token_malformed", "令牌格式不正确");
  let tenantId: unknown;
  let keyId: unknown;
  try {
    tenantId = (JSON.parse(base64UrlDecode(parts[2] as string)) as {tenant_id?: unknown}).tenant_id;
    keyId = (JSON.parse(base64UrlDecode(parts[1] as string)) as {kid?: unknown}).kid;
  } catch {
    throw unauthorized("token_malformed", "令牌段不是合法 JSON");
  }
  if (typeof tenantId !== "string" || typeof keyId !== "string") {
    throw unauthorized("token_malformed", "令牌缺少 tenant_id 或 kid");
  }
  const keyResult = await pool.query<{secret: string}>(
    "SELECT secret FROM auth_keys WHERE tenant_id = $1 AND key_id = $2 AND status IN ('active','retired')",
    [tenantId, keyId],
  );
  const key = keyResult.rows[0];
  if (!key) throw unauthorized("unknown_signing_key", "签名密钥不存在或已吊销");
  const verified = verifyToken(token, key.secret, Math.floor(Date.now() / 1000));
  return {
    tenantId: verified.payload.tenant_id,
    subject: verified.payload.sub,
    role: verified.payload.role,
    keyId: verified.keyId,
  };
}

function buildRoutes(config: AppConfig, pool: Pool): readonly Route[] {
  return [
    {
      method: "POST",
      pattern: /^\/v1\/auth\/rotate$/,
      roles: ["reviewer", "auditor"],
      handler: async ({actor}) => {
        const rotated = await rotateKey(pool, actor.tenantId);
        return {status: 201, body: {tenant_id: actor.tenantId, key_id: rotated.keyId}};
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/events$/,
      roles: ALL_ROLES,
      handler: async ({actor, body}) => {
        const parsed = validateEventEnvelope(body);
        if (parsed.tenantId !== actor.tenantId) {
          throw forbidden("tenant_mismatch", "事件租户与令牌租户不一致");
        }
        const result = await ingestEvent(pool, parsed);
        return {
          status: result.status === "duplicate" ? 200 : 201,
          body: {
            status: result.status,
            event_id: result.event.event_id,
            source_seq: Number(result.event.source_seq),
            decision: decisionView(result.decision, actor.role),
            appeal: result.appeal ? appealView(result.appeal, actor.role) : null,
            resolution_decision: result.resolutionDecision
              ? decisionView(result.resolutionDecision, actor.role)
              : null,
          },
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/accounts\/([^/]+)\/projection$/,
      roles: ALL_ROLES,
      handler: async ({actor, params}) => {
        const accountId = params[0] as string;
        const projection = await getProjection(pool, actor.tenantId, accountId);
        if (!projection) throw notFound("projection_not_found", "账号投影不存在");
        return {status: 200, body: {projection: projectionView(projection, actor.role)}};
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/accounts\/([^/]+)\/timeline$/,
      roles: ALL_ROLES,
      handler: async ({actor, params}) => {
        const accountId = params[0] as string;
        const entries = await getTimeline(pool, actor.tenantId, accountId);
        if (!entries) throw notFound("account_not_found", "账号不存在");
        return {
          status: 200,
          body: {
            account_id: accountId,
            entries: entries.map((entry) => ({
              event: eventView(entry.event, actor.role),
              decision: entry.decision ? decisionView(entry.decision, actor.role) : null,
              appeal: entry.appeal ? appealView(entry.appeal, actor.role) : null,
              resolution_decision: entry.resolution
                ? decisionView(entry.resolution, actor.role)
                : null,
            })),
          },
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/decisions\/(\d+)$/,
      roles: ALL_ROLES,
      handler: async ({actor, params}) => {
        const decision = await getDecisionById(pool, actor.tenantId, Number(params[0]));
        if (!decision) throw notFound("decision_not_found", "决定不存在");
        return {status: 200, body: {decision: decisionView(decision, actor.role)}};
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/appeals\/([^/]+)$/,
      roles: ALL_ROLES,
      handler: async ({actor, params}) => {
        const bundle = await getAppealById(pool, actor.tenantId, params[0] as string);
        if (!bundle) throw notFound("appeal_not_found", "申诉不存在");
        return {
          status: 200,
          body: {
            appeal: appealView(bundle.appeal, actor.role),
            resolution_decision: bundle.resolution
              ? decisionView(bundle.resolution, actor.role)
              : null,
          },
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/appeals\/([^/]+)\/resolve$/,
      roles: ["reviewer"],
      handler: async ({actor, params, body}) => {
        const request = validateResolveRequest(body);
        const resolved = await resolveAppeal(pool, {
          tenantId: actor.tenantId,
          appealId: params[0] as string,
          outcome: request.outcome,
          resolver: actor.subject,
          note: request.note,
        });
        return {
          status: 200,
          body: {
            appeal: appealView(resolved.appeal, actor.role),
            resolution_decision: decisionView(resolved.resolution, actor.role),
          },
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/policies$/,
      roles: ALL_ROLES,
      handler: async ({actor}) => {
        const policies = await listPolicies(pool, actor.tenantId);
        return {
          status: 200,
          body: {
            policies: policies.map((policy) => ({
              version: policy.version,
              name: policy.name,
              rules: policy.rules,
              created_at: policy.created_at.toISOString(),
            })),
          },
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/policies$/,
      roles: ["reviewer"],
      handler: async ({actor, body}) => {
        const request = validatePolicyPublishRequest(body);
        const policy = await publishPolicy(pool, actor.tenantId, request);
        return {
          status: 201,
          body: {
            policy: {
              version: policy.version,
              name: policy.name,
              rules: policy.rules,
              created_at: policy.created_at.toISOString(),
            },
          },
        };
      },
    },
  ];
}

export function createApp(config: AppConfig, pool: Pool): http.Server {
  const routes = buildRoutes(config, pool);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, {status: "ok"});
        return;
      }
      if (req.method === "GET" && pathname === "/ready") {
        try {
          await pool.query("SELECT 1");
          sendJson(res, 200, {status: "ready"});
        } catch {
          sendJson(res, 503, {status: "not_ready"});
        }
        return;
      }

      // 令牌签发是唯一无需验签的业务端点（用引导密钥换取签名令牌）
      if (req.method === "POST" && pathname === "/v1/auth/token") {
        const request = validateTokenRequest(await readJsonBody(req));
        if (request.secret !== config.bootstrapSecret) {
          throw unauthorized("invalid_bootstrap_secret", "引导密钥不正确");
        }
        if (!isRole(request.role)) {
          throw forbidden("invalid_role", "role 必须是 guardian | reviewer | auditor");
        }
        const minted = await mintToken(pool, {
          tenantId: request.tenantId,
          subject: request.subject,
          role: request.role,
          ttlSeconds: config.tokenTtlSeconds,
        });
        sendJson(res, 201, {
          token: minted.token,
          token_type: "Bearer",
          key_id: minted.keyId,
          expires_at: minted.expiresAt,
        });
        return;
      }

      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = route.pattern.exec(pathname);
        if (!match) continue;
        const params = match.slice(1).map((param) => decodeURIComponent(param));
        const body = req.method === "POST" ? await readJsonBody(req) : null;
        const actor = await authenticate(pool, req.headers.authorization);
        if (route.roles.length > 0 && !route.roles.includes(actor.role)) {
          throw forbidden("role_not_allowed", `角色 ${actor.role} 无权访问该资源`);
        }
        const result = await route.handler({actor, params, body});
        sendJson(res, result.status, result.body);
        return;
      }
      throw notFound("not_found", "路由不存在");
    } catch (err) {
      sendError(res, err);
    }
  });
}
