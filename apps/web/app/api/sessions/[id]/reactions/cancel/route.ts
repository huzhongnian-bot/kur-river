// /api/sessions/:id/reactions/cancel —— 取消依次反应批次（§5.4）：
// 清 settings.reactionBatch；已生成的当前草稿保留，可照常确认/放弃。
import { getRepos } from '@/server/repos';
import { cancelReactionBatch } from '@/server/reactions';
import { handleError, json, notFound, type RouteCtx } from '@/server/http';
import { pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.sessions.get(id))) throw notFound(`场次不存在：${id}`);
    const wasActive = await cancelReactionBatch(repos, id);
    return json({ ok: true, wasActive });
  } catch (err) {
    return handleError(err);
  }
}
