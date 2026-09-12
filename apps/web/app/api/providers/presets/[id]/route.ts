// /api/providers/presets/:id —— 单预设读写删
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { optJson, optString, pathUuid } from '@/server/validate';
import type { GenerationParams } from '@kur-river/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const preset = await getRepos().generationPresets.get(id);
    if (!preset) throw notFound(`预设不存在：${id}`);
    return json(preset);
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.generationPresets.get(id))) throw notFound(`预设不存在：${id}`);
    const body = await readBody(req);
    if (Object.keys(body).length === 0) throw badRequest('PATCH 请求体为空');
    let params: GenerationParams | undefined;
    if ('params' in body) {
      const raw = optJson(body, 'params');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw badRequest('字段 params 必须是对象');
      }
      params = raw as GenerationParams;
    }
    const updated = await repos.generationPresets.update(id, {
      name: optString(body, 'name', 200) ?? undefined,
      params,
    });
    if (!updated) throw notFound(`预设不存在：${id}`);
    return json(updated);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const ok = await getRepos().generationPresets.remove(id);
    if (!ok) throw notFound(`预设不存在：${id}`);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
