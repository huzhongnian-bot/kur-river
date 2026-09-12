// /api/worlds/:id —— 单世界书读写删
import { getRepos } from '@/server/repos';
import { handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { optJson, optString, pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const world = await getRepos().worlds.get(id);
    if (!world) throw notFound(`世界书不存在：${id}`);
    return json(world);
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const body = await readBody(req);
    const patch: Record<string, unknown> = {};
    const title = optString(body, 'title', 200);
    if (title !== undefined) patch.title = title;
    if ('premise' in body) patch.premise = optJson(body, 'premise');
    const world = await getRepos().worlds.update(id, patch);
    if (!world) throw notFound(`世界书不存在：${id}`);
    return json(world);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const ok = await getRepos().worlds.remove(id);
    if (!ok) throw notFound(`世界书不存在：${id}`);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
