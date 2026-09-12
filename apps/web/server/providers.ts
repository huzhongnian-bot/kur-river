// providers 路由共享：apiKey 服务端保管，出参一律脱敏（§7.1 前端永不持有明文）。
import type { LlmConnection } from '@kur-river/core';

/** 出参脱敏：apiKey 不回传，以 hasApiKey 告知是否已配置 */
export function toPublicConnection(conn: LlmConnection) {
  const { apiKey: _apiKey, ...rest } = conn;
  return { ...rest, hasApiKey: conn.apiKey.length > 0 };
}
