// /api/worlds/:id/characters/:characterId —— 单角色读写删
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { optJson, optNumber, optString, optUuid, pathUuid } from '@/server/validate';
import type { Character } from '@kur-river/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string; characterId: string }>;

async function load(ctx: Ctx): Promise<Character> {
  const { id, characterId } = await ctx.params;
  pathUuid(id);
  pathUuid(characterId, 'characterId');
  const character = await getRepos().characters.get(characterId);
  if (!character || character.worldId !== id) {
    throw notFound(`角色不存在：${characterId}`);
  }
  return character;
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
    const character = await load(ctx);
    const body = await readBody(req);
    if (Object.keys(body).length === 0) throw badRequest('PATCH 请求体为空');
    const updated = await getRepos().characters.update(character.id, {
      name: optString(body, 'name', 200) ?? undefined,
      avatarUrl: optString(body, 'avatarUrl', 2000),
      card: 'card' in body ? optJson(body, 'card') : undefined,
      secrets: 'secrets' in body ? optJson(body, 'secrets') : undefined,
      talkativeness: optNumber(body, 'talkativeness', { min: 0, max: 1 }) ?? undefined,
      llmConnectionId: optUuid(body, 'llmConnectionId'),
      model: optString(body, 'model', 200),
    });
    if (!updated) throw notFound(`角色不存在：${character.id}`);
    return json(updated);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const character = await load(ctx);
    await getRepos().characters.remove(character.id);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
