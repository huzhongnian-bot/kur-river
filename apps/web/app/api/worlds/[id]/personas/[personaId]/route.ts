// /api/worlds/:id/personas/:personaId —— 单化身读写删
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { optString, pathUuid } from '@/server/validate';
import type { Persona } from '@kur-river/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string; personaId: string }>;

async function load(ctx: Ctx): Promise<Persona> {
  const { id, personaId } = await ctx.params;
  pathUuid(id);
  pathUuid(personaId, 'personaId');
  const persona = await getRepos().personas.get(personaId);
  if (!persona || persona.worldId !== id) throw notFound(`化身不存在：${personaId}`);
  return persona;
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    return json(await load(ctx));
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const persona = await load(ctx);
    const body = await readBody(req);
    if (Object.keys(body).length === 0) throw badRequest('PATCH 请求体为空');
    const updated = await getRepos().personas.update(persona.id, {
      name: optString(body, 'name', 200) ?? undefined,
      description: optString(body, 'description'),
    });
    if (!updated) throw notFound(`化身不存在：${persona.id}`);
    return json(updated);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const persona = await load(ctx);
    await getRepos().personas.remove(persona.id);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
