/** 统一 HTTP 错误：status + 机器可读 code，响应体为 {error, message}。 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (code: string, message?: string): HttpError => new HttpError(400, code, message);
export const unauthorized = (code: string, message?: string): HttpError => new HttpError(401, code, message);
export const forbidden = (code: string, message?: string): HttpError => new HttpError(403, code, message);
export const notFound = (code: string, message?: string): HttpError => new HttpError(404, code, message);
export const conflict = (code: string, message?: string): HttpError => new HttpError(409, code, message);
export const unprocessable = (code: string, message?: string): HttpError => new HttpError(422, code, message);
