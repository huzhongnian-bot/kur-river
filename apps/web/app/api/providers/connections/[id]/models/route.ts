// /api/providers/connections/:id/models —— 调 adapter.listModels 透传可用模型列表。
// 错误友好化：OpenAICompatibleError → 502 + HTTP 状态码；网络错误 → 502 + 连接提示。
import { getAdapter, OpenAICompatibleError } from '@kur-river/llm';
import { getRepos } from '@/server/repos';
import { ApiError, handleError, json, notFound, type RouteCtx } from '@/server/http';
import { pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const connection = await getRepos().llmConnections.get(id);
    if (!connection) throw notFound(`LLM 连接不存在：${id}`);
    try {
      const adapter = getAdapter(connection.providerType);
      return json({ models: await adapter.listModels(connection) });
    } catch (err) {
      if (err instanceof OpenAICompatibleError) {
        throw new ApiError(502, `模型列表拉取失败：上游 HTTP ${err.statusCode} — ${err.responseBody}`);
      }
      throw new ApiError(
        502,
        `模型列表拉取失败：无法连接 ${connection.baseUrl}（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
  } catch (err) {
    return handleError(err);
  }
}
