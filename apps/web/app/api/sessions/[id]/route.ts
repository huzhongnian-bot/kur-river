// /api/sessions/:id —— 单场次读写删；GET 附带在场名单与依次反应批次进度（§5.4）
import { batchProgress, isBatchActive } from '@kur-river/core';
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { optEnum, optJson, optString, pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    const session = await repos.sessions.get(id);
    if (!session) throw notFound(`场次不存在：${id}`);
    const cast = await repos.sessionCast.list(id);
    const batch = session.settings?.reactionBatch ?? null;
    return json({
      ...session,
      castCharacterIds: cast,
      reactionBatch: batch,
      reactionProgress: isBatchActive(batch) && batch ? batchProgress(batch) : null,
    });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.sessions.get(id))) throw notFound(`场次不存在：${id}`);
    const body = await readBody(req);
    if (Object.keys(body).length === 0) throw badRequest('PATCH 请求体为空');
    const updated = await repos.sessions.update(id, {
      title: optString(body, 'title', 500),
      scene: 'scene' in body ? optJson(body, 'scene') : undefined,
      status: optEnum(body, 'status', ['active', 'archived'] as const),
      settings: ('settings' in body ? optJson(body, 'settings') : undefined) as never,
    });
    if (!updated) throw notFound(`场次不存在：${id}`);
    return json(updated);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const ok = await getRepos().sessions.remove(id);
    if (!ok) throw notFound(`场次不存在：${id}`);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
