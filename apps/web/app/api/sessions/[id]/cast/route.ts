// /api/sessions/:id/cast —— 在场名单：上场（POST）。上场须为团队成员（§2.1 在场名单是成员子集）。
// 上场后按 §5.2.2 尝试造开场草稿（场次还没有任何消息/草稿时）。
import { getRepos } from '@/server/repos';
import { maybeCreateOpeningDraft } from '@/server/generation';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { pathUuid, reqUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.sessions.get(id))) throw notFound(`场次不存在：${id}`);
    return json(await repos.sessionCast.list(id));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    const session = await repos.sessions.get(id);
    if (!session) throw notFound(`场次不存在：${id}`);
    const body = await readBody(req);
    const characterId = reqUuid(body, 'characterId');
    const members = await repos.troupeMembers.list(session.troupeId);
    if (!members.includes(characterId)) {
      throw badRequest(`上场角色须为团队成员：${characterId}`);
    }
    await repos.sessionCast.add(id, characterId);
    const openingDraft = await maybeCreateOpeningDraft(repos, id);
    return json({ castCharacterIds: await repos.sessionCast.list(id), openingDraft }, 201);
  } catch (err) {
    return handleError(err);
  }
}
