import {createHash, createHmac, randomBytes, timingSafeEqual} from "node:crypto";

/** 键序稳定的 JSON 序列化，用于负载摘要与决定哈希链。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${parts.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hmacSha256Hex(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

export function hmacEqual(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function randomKeySecret(): string {
  return randomBytes(32).toString("hex");
}

export function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}
