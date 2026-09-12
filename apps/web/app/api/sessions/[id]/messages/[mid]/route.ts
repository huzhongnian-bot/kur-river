// /api/sessions/:id/messages/:mid —— 编辑已落盘消息（§7.1 M3）。
// PATCH 两种形式（与草稿 PATCH 同规则）：{ text } 重包单 public 段 / { segments } 整体替换。
// 已归档场次的任何消息变更触发该场记忆作废重算 + epoch 连带重建（§2.2 v0.4，进程内异步）；
// active 场次的编辑不触发记忆逻辑（记忆只在归档时产生）。
import { singleSegment } from '@/server/generation';
import { recomputeArchivedSession } from '@/server/memory';
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { parseSegments } from '@/server/segments';
import { pathUuid, reqString } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string; mid: string }>;

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id, mid } = await ctx.params;
    pathUuid(id);
    pathUuid(mid, 'mid');
    const repos = getRepos();
    const session = await repos.sessions.get(id);
    if (!session) throw notFound(`场次不存在：${id}`);
    const message = await repos.messages.get(mid);
    if (!message || message.sessionId !== id) throw notFound(`消息不存在或不属于本场次：${mid}`);

    const body = await readBody(req);
    const hasSegments = 'segments' in body;
    const hasText = 'text' in body;
    if (hasSegments && hasText) throw badRequest('segments 与 text 只能二选一');
    if (!hasSegments && !hasText) throw badRequest('PATCH 需要 segments 或 text 字段');
    const content = hasSegments
      ? parseSegments(body.segments)
      : singleSegment(reqString(body, 'text'));

    const updated = await repos.messages.update(mid, { content });
    if (!updated) throw notFound(`消息不存在：${mid}`);
    // §2.2 v0.4：已归档场次的消息变更 → 该场记忆作废重算（异步）
    if (session.status === 'archived') {
      recomputeArchivedSession(repos, id, session.troupeId);
    }
    return json({ message: updated, memoryRecompute: session.status === 'archived' });
  } catch (err) {
    return handleError(err);
  }
}
