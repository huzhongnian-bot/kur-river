// /api/troupes/:id/members —— 团队成员：从角色池选角（成员须属同一 world 的角色池，§2.1）
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { pathUuid, reqUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.troupes.get(id))) throw notFound(`团队不存在：${id}`);
    return json(await repos.troupeMembers.list(id));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    const troupe = await repos.troupes.get(id);
    if (!troupe) throw notFound(`团队不存在：${id}`);
    const body = await readBody(req);
    const characterId = reqUuid(body, 'characterId');
    const character = await repos.characters.get(characterId);
    if (!character || character.worldId !== troupe.worldId) {
      throw badRequest(`成员须属同一世界的角色池：${characterId}`);
    }
    await repos.troupeMembers.add(id, characterId);
    return json(await repos.troupeMembers.list(id), 201);
  } catch (err) {
    return handleError(err);
  }
}
