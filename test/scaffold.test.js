import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("策略契约包含版本与角色", async () => {
  const policy = JSON.parse(await readFile(new URL("../contracts/policy.json", import.meta.url), "utf8"));
  assert.equal(typeof policy.version, "string");
  assert.deepEqual(policy.roles, ["guardian", "reviewer", "auditor"]);
});
