// /api/worlds/:id/lorebook —— 世界书条目 CRUD（§2.2 LorebookEntry）。
// M1 暴露 world / character 两级 scope（session 级随归档生命周期，M3 前后再开）；
// character 级条目的 visibility：public 在场全员生效 / private 仅注入本人。
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import {
  isUuid,
  optBool,
  optEnum,
  optNumber,
  optString,
  optStringArray,
  pathUuid,
  reqString,
} from '@/server/validate';
import type { LorebookPosition } from '@kur-river/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

const POSITIONS: readonly LorebookPosition[] = ['before_char', 'after_char', 'at_depth'];

/** 收集本 world 可见的条目：world 级 + 全角色池的 character 级 */
async function listForWorld(worldId: string) {
  const repos = getRepos();
  const characters = await repos.characters.listByWorld(worldId);
  const scopes = [
    { ownerType: 'world' as const, ownerId: worldId },
    ...characters.map((c) => ({ ownerType: 'character' as const, ownerId: c.id })),
  ];
  return repos.lorebookEntries.listByScopes(scopes);
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    if (!(await getRepos().worlds.get(id))) throw notFound(`世界书不存在：${id}`);
    return json(await listForWorld(id));
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

    const ownerType = optEnum(body, 'ownerType', ['world', 'character'] as const) ?? 'world';
    let ownerId = id;
    if (ownerType === 'character') {
      const raw = body.ownerId;
      if (typeof raw !== 'string' || !isUuid(raw)) {
        throw badRequest('character 级条目必须提供合法 UUID 的 ownerId（角色 ID）');
      }
      const character = await repos.characters.get(raw);
      if (!character || character.worldId !== id) {
        throw badRequest(`ownerId 角色不存在或不属于本世界：${raw}`);
      }
      ownerId = raw;
    }

    const position = optEnum(body, 'position', POSITIONS) ?? 'before_char';
    const entry = await repos.lorebookEntries.create({
      ownerType,
      ownerId,
      visibility: optEnum(body, 'visibility', ['public', 'private'] as const) ?? 'public',
      keys: optStringArray(body, 'keys') ?? [],
      secondaryKeys: optStringArray(body, 'secondaryKeys'),
      content: reqString(body, 'content'),
      position,
      depth: optNumber(body, 'depth', { int: true, min: 0 }),
      insertionOrder: optNumber(body, 'insertionOrder', { int: true }) ?? undefined,
      scanDepth: optNumber(body, 'scanDepth', { int: true, min: 0 }),
      tokenBudget: optNumber(body, 'tokenBudget', { int: true, min: 0 }),
      enabled: optBool(body, 'enabled'),
    });
    return json(entry, 201);
  } catch (err) {
    return handleError(err);
  }
}
