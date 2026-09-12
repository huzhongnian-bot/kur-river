// /api/sessions/:id/messages/truncate —— 截断重演（§7.1 M3）：
// 保留 seq ≤ 指定值的消息，删除其后的全部消息；悬挂草稿统一 discard
// （重演从截断点重新生成）。已归档场次截断同样触发记忆作废重算 + epoch 重建（§2.2）。
import { discardHangingDrafts } from '@/server/drafts';
import { recomputeArchivedSession } from '@/server/memory';
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    const session = await repos.sessions.get(id);
    if (!session) throw notFound(`场次不存在：${id}`);

    const body = await readBody(req);
    const seq = body.seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      throw badRequest('字段 seq 必填且必须是非负整数');
    }

    const deleted = await repos.messages.truncateAfter(id, seq);
    const discardedDrafts = await discardHangingDrafts(repos, id);
    if (session.status === 'archived') {
      recomputeArchivedSession(repos, id, session.troupeId);
    }
    return json({ deleted, discardedDrafts, memoryRecompute: session.status === 'archived' });
  } catch (err) {
    return handleError(err);
  }
}
