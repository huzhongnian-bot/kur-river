// /api/worlds/:id/lorebook/:entryId —— 单条目读写删（条目须属于本 world 的 scope 范围）
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import {
  optBool,
  optEnum,
  optNumber,
  optString,
  optStringArray,
  pathUuid,
} from '@/server/validate';
import type { LorebookEntry, LorebookPosition } from '@kur-river/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string; entryId: string }>;

const POSITIONS: readonly LorebookPosition[] = ['before_char', 'after_char', 'at_depth'];

async function load(ctx: Ctx): Promise<LorebookEntry> {
  const { id, entryId } = await ctx.params;
  pathUuid(id);
  pathUuid(entryId, 'entryId');
  const repos = getRepos();
  const entry = await repos.lorebookEntries.get(entryId);
  if (!entry) throw notFound(`条目不存在：${entryId}`);
  // world 级直接比对；character 级确认角色属于本 world
  if (entry.ownerType === 'world') {
    if (entry.ownerId !== id) throw notFound(`条目不存在：${entryId}`);
  } else if (entry.ownerType === 'character') {
    const character = await repos.characters.get(entry.ownerId);
    if (!character || character.worldId !== id) throw notFound(`条目不存在：${entryId}`);
  } else {
    throw badRequest('session 级条目不在本路由管理范围内');
  }
  return entry;
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
    const entry = await load(ctx);
    const body = await readBody(req);
    if (Object.keys(body).length === 0) throw badRequest('PATCH 请求体为空');
    const updated = await getRepos().lorebookEntries.update(entry.id, {
      visibility: optEnum(body, 'visibility', ['public', 'private'] as const),
      keys: optStringArray(body, 'keys') ?? undefined,
      secondaryKeys: optStringArray(body, 'secondaryKeys'),
      content: optString(body, 'content') ?? undefined,
      position: optEnum(body, 'position', POSITIONS),
      depth: optNumber(body, 'depth', { int: true, min: 0 }),
      insertionOrder: optNumber(body, 'insertionOrder', { int: true }) ?? undefined,
      scanDepth: optNumber(body, 'scanDepth', { int: true, min: 0 }),
      tokenBudget: optNumber(body, 'tokenBudget', { int: true, min: 0 }),
      enabled: optBool(body, 'enabled'),
    });
    if (!updated) throw notFound(`条目不存在：${entry.id}`);
    return json(updated);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const entry = await load(ctx);
    await getRepos().lorebookEntries.remove(entry.id);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
