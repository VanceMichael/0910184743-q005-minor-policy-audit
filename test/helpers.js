import EmbeddedPostgres from "embedded-postgres";
import net from "node:net";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createApp} from "../dist/app.js";
import {createPool} from "../dist/db.js";
import {runMigrations} from "../dist/migrate.js";

export const BOOTSTRAP_SECRET = "test-bootstrap";

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 拉起真实 PostgreSQL 16（embedded-postgres，平台二进制随 npm 包安装）。 */
export async function startPostgres() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "mpg-data-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: true,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("app");
  return {
    pg,
    dataDir,
    port,
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/app`,
    async cleanup() {
      await pg.stop().catch(() => undefined);
      await rm(dataDir, {recursive: true, force: true}).catch(() => undefined);
    },
  };
}

/** 迁移 + 启动应用（随机端口）。 */
export async function startApp(databaseUrl) {
  const pool = createPool(databaseUrl);
  await runMigrations(pool);
  const config = {
    port: 0,
    databaseUrl,
    bootstrapSecret: BOOTSTRAP_SECRET,
    tokenTtlSeconds: 3600,
    schemaVersion: "001_initial",
    dbConnectTimeoutMs: 10_000,
  };
  const server = createApp(config, pool);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    pool,
    server,
    async close() {
      server.close();
      await pool.end().catch(() => undefined);
    },
  };
}

export async function api(base, {method = "GET", path: routePath, token, body}) {
  const response = await fetch(base + routePath, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? {authorization: `Bearer ${token}`} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return {status: response.status, body: json};
}

export async function getToken(base, tenantId, role, subject = "tester") {
  const res = await api(base, {
    method: "POST",
    path: "/v1/auth/token",
    body: {tenant_id: tenantId, subject, role, secret: BOOTSTRAP_SECRET},
  });
  if (res.status !== 201) {
    throw new Error(`签发令牌失败: ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

let seqCounter = 0;
export function uniqueId(prefix) {
  seqCounter += 1;
  return `${prefix}-${process.pid}-${seqCounter}`;
}
