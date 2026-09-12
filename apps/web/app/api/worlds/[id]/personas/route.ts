// /api/worlds/:id/personas —— 导演化身 CRUD（§2.2 Persona：{{user}} 宏替换来源）
import { getRepos } from '@/server/repos';
import { handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { optString, pathUuid, reqString } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.worlds.get(id))) throw notFound(`世界书不存在：${id}`);
    return json(await repos.personas.listByWorld(id));
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
    const persona = await repos.personas.create({
      worldId: id,
      name: reqString(body, 'name', 200),
      description: optString(body, 'description'),
    });
    return json(persona, 201);
  } catch (err) {
    return handleError(err);
  }
}
