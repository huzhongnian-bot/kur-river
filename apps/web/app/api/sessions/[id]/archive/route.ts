// /api/sessions/:id/archive —— 场次归档（§7.1、§2.2）。
// 归档：status=archived + 该场 session 级世界书条目批量 enabled=false +
// 悬挂草稿（queued/generating/ready）统一 discard（M2 遗留清理）→
// 发 session.archived 事件（订阅者对该场每个在场角色生成记忆摘要）。
// 幂等：已归档场次返回 200（不重复归档），并"补算"缺失摘要的角色
// （成功 = 摘要记录存在，天然可检测）；失败信息经响应 memoryErrors 携带。
import { getRepos } from '@/server/repos';
import { discardHangingDrafts } from '@/server/drafts';
import { getEventBus } from '@/server/events';
import { memoryErrorsOf, summarizeSessionFor } from '@/server/memory';
import { ensureSubscribers } from '@/server/subscribers';
import { handleError, json, notFound, type RouteCtx } from '@/server/http';
import { pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function POST(_req: Request, ctx: Ctx) {
  try {
    ensureSubscribers();
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    const session = await repos.sessions.get(id);
    if (!session) throw notFound(`场次不存在：${id}`);

    // 幂等路径：已归档 → 200，并补算缺摘要的角色（含此前失败的）
    if (session.status === 'archived') {
      const castIds = await repos.sessionCast.list(id);
      let healed = 0;
      for (const characterId of castIds) {
        const records = (await repos.memories.list(characterId, session.troupeId)).filter(
          (r) => r.sessionId === id && r.kind === 'session',
        );
        if (records.length === 0) {
          void summarizeSessionFor(repos, { sessionId: id, troupeId: session.troupeId, characterId });
          healed++;
        }
      }
      return json({ session, alreadyArchived: true, healingSummaries: healed, memoryErrors: memoryErrorsOf(id) });
    }

    const updated = await repos.sessions.update(id, { status: 'archived' });
    if (!updated) throw notFound(`场次不存在：${id}`);
    const disabledEntries = await repos.lorebookEntries.disableBySession(id);
    const discardedDrafts = await discardHangingDrafts(repos, id);
    getEventBus().emit('session.archived', { session: updated });
    return json({ session: updated, alreadyArchived: false, disabledEntries, discardedDrafts });
  } catch (err) {
    return handleError(err);
  }
}
