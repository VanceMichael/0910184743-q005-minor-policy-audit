import http, {type IncomingMessage, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";
import type {Db} from "./db.js";
import {rotateKey} from "./db.js";
import {authenticate, assertSameTenant, AuthError, type Principal} from "./auth.js";
import {parseEnvelope, ValidationError} from "./domain/validation.js";
import {ingestEvent, ConflictError, NotFoundError} from "./ingest.js";
import {
  getAppealByEvent,
  getDecisionByEvent,
  getEventBySeq,
  getProjection,
  listAppeals,
  listDecisions,
  listEvents,
} from "./store.js";
import {appealView, decisionView, eventView, projectionView} from "./views.js";
import type {AppConfig} from "./config.js";

type Req = IncomingMessage;
type Res = ServerResponse;

function sendJson(res: Res, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {"content-type": "application/json; charset=utf-8"});
  res.end(payload);
}

function readBody(req: Req): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const PATH_PREFIX = "/v1/tenants/";

function matchAccountRoute(pathname: string) {
  // /v1/tenants/:tenant/accounts/:account/<rest...>
  if (!pathname.startsWith(PATH_PREFIX)) return null;
  const rest = pathname.slice(PATH_PREFIX.length);
  const parts = rest.split("/");
  // tenant, 'accounts', account, resource...
  if (parts[1] !== "accounts" || parts.length < 4) return null;
  return {
    tenant: decodeURIComponent(parts[0]!),
    account: decodeURIComponent(parts[2]!),
    segments: parts.slice(3),
  };
}

export function createServer(db: Db, config: AppConfig): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      await handle(db, config, req, res);
    } catch (error) {
      handleError(error, res);
    }
  });
  return server;
}

async function handle(db: Db, config: AppConfig, req: Req, res: Res): Promise<void> {
  const method = req.method!;
  const pathname = new URL(req.url!, "http://localhost").pathname;

  if (method === "GET" && pathname === "/health") {
    try {
      await db.query("SELECT 1");
      sendJson(res, 200, {status: "ok", database: "up"});
    } catch {
      sendJson(res, 503, {status: "degraded", database: "down"});
    }
    return;
  }

  // 管理端：密钥轮换（独立管理令牌，非业务签名）
  if (method === "POST" && pathname === "/admin/rotate-key") {
    await handleRotateKey(db, config, req, res);
    return;
  }

  const route = matchAccountRoute(pathname);
  if (!route) {
    sendJson(res, 404, {error: "not_found"});
    return;
  }

  const rawBody = await readBody(req);
  const principal = await authenticate(
    db.pool,
    {method, url: req.url!, headers: req.headers as Record<string, string | undefined>},
    rawBody,
    {maxClockSkewSeconds: config.maxClockSkewSeconds},
  );
  assertSameTenant(principal, route.tenant);

  const [resource, param] = route.segments;

  if (method === "POST" && resource === "events") {
    // POST /v1/tenants/:t/accounts/:a/events/:source_seq/:event_id
    // 入口四要素 tenant_id / account_id / source_seq / event_id 全部在路径上
    if (!param || route.segments.length < 3) {
      throw new ValidationError("事件入口路径必须为 /events/:source_seq/:event_id");
    }
    const body = rawBody.length > 0 ? (JSON.parse(rawBody.toString("utf8")) as unknown) : {};
    const envelope = parseEnvelope(
      {
        tenant_id: route.tenant,
        account_id: route.account,
        source_seq: param,
        event_id: decodeURIComponent(route.segments[2]!),
      },
      body,
    );
    const fault = config.allowFaultInjection && req.headers["x-fault"] === "abort";
    const result = await ingestEvent(db, envelope, principal.keyId, fault);
    sendJson(res, 200, {event_id: envelope.eventId, ...result});
    return;
  }

  if (method !== "GET") {
    sendJson(res, 405, {error: "method_not_allowed"});
    return;
  }

  // ---------- 读模型（全部按租户+账号过滤，签名身份已限定租户） ----------
  const rows = await db.withTransaction(async (client) => {
    if (resource === "projection") {
      const row = await getProjection(client, route.tenant, route.account);
      return {kind: "projection" as const, view: projectionView(row, principal.role, principal.subject)};
    }
    if (resource === "events" && param === undefined) {
      const list = await listEvents(client, route.tenant, route.account);
      return {kind: "list" as const, view: list.map((r) => eventView(r, principal.role, principal.subject))};
    }
    if (resource === "events" && param !== undefined) {
      // 旧序号可查询：按 source_seq 取事实事件（含 applied=false 的迟到事件）
      const seq = Number(param);
      if (!Number.isSafeInteger(seq) || seq < 1) throw new ValidationError("source_seq 必须是正整数");
      const row = await getEventBySeq(client, route.tenant, route.account, seq);
      if (!row) throw new NotFoundError(`source_seq=${seq} 无事件`);
      return {kind: "one" as const, view: eventView(row, principal.role, principal.subject)};
    }
    if (resource === "decisions" && param === undefined) {
      const list = await listDecisions(client, route.tenant, route.account);
      return {kind: "list" as const, view: list.map((r) => decisionView(r, principal.role, principal.subject))};
    }
    if (resource === "decisions" && param !== undefined) {
      const row = await getDecisionByEvent(client, route.tenant, route.account, decodeURIComponent(param));
      if (!row) throw new NotFoundError("决定不存在");
      return {kind: "one" as const, view: decisionView(row, principal.role, principal.subject)};
    }
    if (resource === "appeals" && param === undefined) {
      const list = await listAppeals(client, route.tenant, route.account);
      return {kind: "list" as const, view: list.map((r) => appealView(r, principal.role))};
    }
    if (resource === "appeals" && param !== undefined) {
      const row = await getAppealByEvent(client, route.tenant, route.account, decodeURIComponent(param));
      if (!row) throw new NotFoundError("申诉不存在");
      return {kind: "one" as const, view: appealView(row, principal.role)};
    }
    throw new NotFoundError("未知资源");
  });

  sendJson(res, 200, rows.kind === "list" ? {items: rows.view} : rows.view);
}

async function handleRotateKey(db: Db, config: AppConfig, req: Req, res: Res): Promise<void> {
  if (req.headers["x-admin-token"] !== config.adminToken) {
    throw new AuthError(401, "管理令牌缺失或错误");
  }
  const raw = await readBody(req);
  const body = JSON.parse(raw.toString("utf8") || "{}") as {
    tenant_id?: string;
    old_key_id?: string;
    new_key_id?: string;
    new_secret?: string;
  };
  if (!body.tenant_id || !body.old_key_id || !body.new_key_id || !body.new_secret) {
    throw new ValidationError("需要 tenant_id、old_key_id、new_key_id、new_secret");
  }
  await rotateKey(db, body.tenant_id, body.old_key_id, {
    key_id: body.new_key_id,
    secret: body.new_secret,
  });
  sendJson(res, 200, {rotated: true, tenant_id: body.tenant_id, retired_key_id: body.old_key_id, active_key_id: body.new_key_id});
}

function handleError(error: unknown, res: Res): void {
  if (error instanceof AuthError) {
    sendJson(res, error.status, {error: "unauthorized", message: error.message});
    return;
  }
  if (error instanceof ValidationError) {
    sendJson(res, 422, {error: "validation_error", message: error.message});
    return;
  }
  if (error instanceof NotFoundError) {
    sendJson(res, 404, {error: "not_found", message: error.message});
    return;
  }
  if (error instanceof ConflictError) {
    sendJson(res, 409, {error: "conflict", message: error.message});
    return;
  }
  const code = (error as {code?: string}).code;
  if (code === "23505") {
    sendJson(res, 409, {error: "conflict", message: "唯一约束冲突：event_id 或 source_seq 已存在"});
    return;
  }
  if (error instanceof SyntaxError) {
    sendJson(res, 400, {error: "bad_json", message: "请求体不是合法 JSON"});
    return;
  }
  console.error("未处理错误：", error);
  sendJson(res, 500, {error: "internal_error"});
}

export async function startServer(config: AppConfig, db: Db): Promise<http.Server> {
  const server = createServer(db, config);
  await new Promise<void>((resolve) => server.listen(config.port, "0.0.0.0", () => resolve()));
  const address = server.address() as AddressInfo;
  console.log(`策略判定服务监听 :${address.port}`);
  return server;
}
