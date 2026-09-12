// Route Handler 公共助手：统一错误形状 { error: string }、JSON 体解析、参数解包。

/** 业务错误：status + 面向用户的中文信息 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, message);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, message);
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** Next 15 App Router：动态段参数是 Promise */
export type RouteCtx<P extends Record<string, string>> = { params: Promise<P> };

/** 解析 JSON 请求体；非对象一律 400 */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('请求体必须是 JSON 对象');
  }
  return body as Record<string, unknown>;
}

/** 统一错误出口：ApiError 原样状态码，其余 500 */
export function handleError(err: unknown): Response {
  if (err instanceof ApiError) {
    return json({ error: err.message }, err.status);
  }
  console.error('[kur-river api]', err);
  return json({ error: err instanceof Error ? err.message : String(err) }, 500);
}
