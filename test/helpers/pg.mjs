import {spawn} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const {Client} = pg;

/**
 * 测试用 PostgreSQL 16 集群管理：
 *  - 设置了 TEST_DATABASE_URL 时直接复用外部库（每个测试文件使用独立租户隔离）；
 *  - 否则使用 PG_BIN_DIR 指向的本地 postgres 二进制，在临时数据目录 initdb 并启动，
 *    支持 stop()/start() 用同一数据目录模拟“数据库重启 + 持久卷”。
 */
export async function createTestCluster() {
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    return {
      appUrl: external,
      adminUrl: process.env.TEST_ADMIN_URL ?? external,
      managed: false,
      restart: async () => {},
      destroy: async () => {},
    };
  }

  const binDir = process.env.PG_BIN_DIR ?? "/tmp/pg/bin";
  const libDir = path.join(binDir, "..", "lib");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pgtest-"));
  const port = 54300 + Math.floor(Math.random() * 500);
  const sockDir = dataDir;
  const env = {...process.env, LD_LIBRARY_PATH: libDir};

  const run = (cmd, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(path.join(binDir, cmd), args, {env});
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} 失败: ${out}`))));
    });

  await run("initdb", ["-D", dataDir, "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"]);

  const ctl = (args) => run("pg_ctl", ["-D", dataDir, "-o", `-p ${port} -k ${sockDir} -c fsync=on -c full_page_writes=on`, ...args]);

  await ctl(["-l", path.join(dataDir, "pg.log"), "start"]);
  const adminUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  await waitForReady(adminUrl);

  const admin = new Client(adminUrl);
  await admin.connect();
  await admin.query("CREATE ROLE minor_policy LOGIN PASSWORD 'minor_policy'").catch(() => {});
  await admin.query("CREATE DATABASE minor_policy OWNER minor_policy").catch(() => {});
  await admin.end();

  const appUrl = `postgresql://minor_policy:minor_policy@127.0.0.1:${port}/minor_policy`;

  let stopped = false;
  return {
    appUrl,
    adminUrl,
    managed: true,
    async restart(mode = "immediate") {
      await ctl(["-m", mode, "stop"]);
      stopped = true;
      await ctl(["-l", path.join(dataDir, "pg.log"), "start"]);
      await waitForReady(adminUrl);
      stopped = false;
    },
    async destroy() {
      if (!stopped) await ctl(["-m", "immediate", "stop"]).catch(() => {});
      await rm(dataDir, {recursive: true, force: true});
    },
  };
}

export async function waitForReady(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    const client = new Client(url);
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      await client.end().catch(() => {});
    }
  }
  throw new Error(`数据库未就绪：${url}`);
}
