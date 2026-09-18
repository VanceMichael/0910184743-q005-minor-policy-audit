import type {IncomingMessage, ServerResponse} from "node:http";
import {HttpError, badRequest} from "./errors.js";
import {mapPgError} from "./db.js";

const MAX_BODY_BYTES = 1_048_576;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large", "请求体超过 1MB 上限");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw badRequest("invalid_json", "请求体不能为空");
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest("invalid_json", "请求体不是合法 JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {"content-type": "application/json; charset=utf-8"});
  res.end(payload);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, {error: err.code, message: err.message});
    return;
  }
  const mapped = mapPgError(err);
  if (mapped) {
    sendJson(res, mapped.status, {error: mapped.code, message: mapped.message});
    return;
  }
  console.error("未处理错误:", err);
  sendJson(res, 500, {error: "internal_error", message: "服务内部错误"});
}
