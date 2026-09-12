// /api/drafts/:id/confirm —— 确认落盘（§5.6）：事务内转 message（seq 串行化在仓储层）。
// 可选 body { text }：确认时一并定稿（等价于先 PATCH 再 confirm）；空 body 用草稿现状。
// 依次反应挂接（§5.4）：落盘后若该草稿是批次当前角色 → advanceBatch，
// 有下一角色则自动建其生成草稿，耗尽则清批次（响应 reaction 字段携带推进结果）。
import { confirmDraft, DraftTransitionError } from '@kur-river/core';
import { getRepos } from '@/server/repos';
import { getEventBus } from '@/server/events';
import { singleSegment } from '@/server/generation';
import { advanceReactionBatchAfterDraft } from '@/server/reactions';
import { badRequest, handleError, json, type RouteCtx } from '@/server/http';
import { optString, pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    let content;
    const raw = await req.text();
    if (raw.trim().length > 0) {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw badRequest('请求体不是合法 JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw badRequest('请求体必须是 JSON 对象');
      }
      const text = optString(body as Record<string, unknown>, 'text');
      if (text != null) content = singleSegment(text);
    }
    const repos = getRepos();
    const result = await confirmDraft(repos, id, content ? { content } : {});
    getEventBus().emit('message.confirmed', result);
    // §5.4 严格串行：上一角色落盘后批次才推进（后续角色上下文含已确认反应）
    const reaction = await advanceReactionBatchAfterDraft(repos, result.draft);
    return json({ ...result, reaction });
  } catch (err) {
    if (err instanceof DraftTransitionError) return handleError(badRequest(err.message));
    return handleError(err);
  }
}
