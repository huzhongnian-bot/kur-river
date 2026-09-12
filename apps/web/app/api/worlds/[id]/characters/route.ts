// /api/worlds/:id/characters —— 角色池 CRUD（§2.2 Character：card/secrets 为 JSONB 载荷）
import { getRepos } from '@/server/repos';
import { handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { optJson, optNumber, optString, optUuid, pathUuid, reqString } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.worlds.get(id))) throw notFound(`世界书不存在：${id}`);
    return json(await repos.characters.listByWorld(id));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.worlds.get(id))) throw notFound(`世界书不存在：${id}`);
    const body = await readBody(req);
    const character = await repos.characters.create({
      worldId: id,
      name: reqString(body, 'name', 200),
      avatarUrl: optString(body, 'avatarUrl', 2000),
      card: optJson(body, 'card'),
      secrets: optJson(body, 'secrets'),
      talkativeness: optNumber(body, 'talkativeness', { min: 0, max: 1 }) ?? undefined,
      llmConnectionId: optUuid(body, 'llmConnectionId'),
      model: optString(body, 'model', 200),
    });
    return json(character, 201);
  } catch (err) {
    return handleError(err);
  }
}
