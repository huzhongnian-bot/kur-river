// 客户端 fetch 助手：同源走浏览器 Basic Auth 会话（middleware.ts 密码门），
// 统一解 { error } 错误形状为异常。
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status}：响应不是 JSON`);
    }
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

export function body(payload: unknown): Pick<RequestInit, 'method' | 'body'> {
  return { method: 'POST', body: JSON.stringify(payload) };
}

export function patch(payload: unknown): Pick<RequestInit, 'method' | 'body'> {
  return { method: 'PATCH', body: JSON.stringify(payload) };
}

export function put(payload: unknown): Pick<RequestInit, 'method' | 'body'> {
  return { method: 'PUT', body: JSON.stringify(payload) };
}

export function del(): Pick<RequestInit, 'method'> {
  return { method: 'DELETE' };
}
