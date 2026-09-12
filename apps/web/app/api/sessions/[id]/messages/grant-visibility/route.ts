// /api/sessions/:id/messages/grant-visibility —— 补发可见性（§2.2）：
// 把角色追加进场次历史消息（可选 seq 上限）的 visibleTo，
// 供晚加入角色补看上场前剧情（可见性快照语义的显式例外，导演操作）。
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { optNumber, pathUuid, reqUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.sessions.get(id))) throw notFound(`场次不存在：${id}`);

    const body = await readBody(req);
    const characterId = reqUuid(body, 'characterId');
    // 补发对象须在场（可见性快照面向在场角色；不在场多半是调错对象）
    const castIds = await repos.sessionCast.list(id);
    if (!castIds.includes(characterId)) {
      throw badRequest(`角色不在在场名单中：${characterId}`);
    }
    const upToSeq = optNumber(body, 'upToSeq', { int: true, min: 1 }) ?? undefined;

    const granted = await repos.messages.grantVisibility(id, characterId, {
      ...(upToSeq !== undefined ? { upToSeq } : {}),
    });
    return json({ granted });
  } catch (err) {
    return handleError(err);
  }
}
