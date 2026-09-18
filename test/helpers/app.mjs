import {createDb, runMigrations, seedKeys} from "../../dist/db.js";
import {loadConfig} from "../../dist/config.js";
import {createServer} from "../../dist/server.js";
import {buildAuthHeader} from "../../dist/auth.js";

export const DEFAULT_KEYS = [
  {tenant_id: "t-alpha", key_id: "k-alpha-1", secret: "secret-alpha-1", roles: ["guardian", "reviewer", "auditor"], subject: "guardian-1"},
  {tenant_id: "t-beta", key_id: "k-beta-1", secret: "secret-beta-1", roles: ["guardian", "reviewer", "auditor"]},
  {tenant_id: "t-alpha", key_id: "k-alpha-old", secret: "secret-alpha-old", status: "retired", roles: ["guardian", "reviewer", "auditor"]},
  {tenant_id: "t-rotate", key_id: "k-rotate-1", secret: "secret-rotate-1", roles: ["guardian", "reviewer", "auditor"]},
];

export async function startTestApp({appUrl, port = 0, keys = DEFAULT_KEYS, allowFault = true}) {
  const db = createDb(appUrl);
  await runMigrations(db, new URL("../../migrations/", import.meta.url).pathname);
  await seedKeys(db, keys);

  const config = {
    ...loadConfigMeta(),
    databaseUrl: appUrl,
    port,
    maxClockSkewSeconds: 300,
    adminToken: "test-admin-token",
    allowFaultInjection: allowFault,
  };
  const server = createServer(db, config);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const client = createClient(base, keys);

  return {
    base,
    db,
    client,
    async rotateKey(body) {
      const res = await fetch(`${base}/admin/rotate-key`, {
        method: "POST",
        headers: {"x-admin-token": "test-admin-token", "content-type": "application/json"},
        body: JSON.stringify(body),
      });
      return {status: res.status, body: await res.json()};
    },
    async health() {
      const res = await fetch(`${base}/health`);
      return {status: res.status, body: await res.json()};
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

function loadConfigMeta() {
  // 复用真实配置默认值，再用测试值覆盖
  process.env.DATABASE_URL ??= "postgresql://unused";
  return loadConfig();
}

export function createClient(base, keys = DEFAULT_KEYS) {
  const byId = new Map(keys.map((k) => [k.key_id, k]));

  return async function request({
    method = "GET",
    pathname,
    keyId = "k-alpha-1",
    role = "reviewer",
    subject,
    body = null,
    headers = {},
  }) {
    const key = byId.get(keyId);
    const keySecret = key?.secret ?? "unknown";
    const tenant = key?.tenant_id ?? "unknown";
    const raw = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const auth = buildAuthHeader({
      method,
      pathname,
      tenant,
      keyId,
      secret: keySecret,
      role,
      subject: subject ?? key?.subject ?? null,
      rawBody: raw,
    });
    const res = await fetch(base + pathname, {
      method,
      headers: {authorization: auth, "content-type": "application/json", ...headers},
      body: raw.length > 0 ? raw : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return {status: res.status, body: json};
  };
}
