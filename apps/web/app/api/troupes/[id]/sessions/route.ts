// /api/troupes/:id/sessions —— 场次 CRUD（§2.2 Session）。
// POST 支持 castCharacterIds 初始上场（须为团队成员）；创建后按 §5.2.2
// 尝试造 ready 态开场草稿（首个上场角色卡带 first_mes 时）。
import { getRepos } from '@/server/repos';
import { maybeCreateOpeningDraft } from '@/server/generation';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { isUuid, optEnum, optJson, optString, pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.troupes.get(id))) throw notFound(`团队不存在：${id}`);
    return json(await repos.sessions.listByTroupe(id));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.troupes.get(id))) throw notFound(`团队不存在：${id}`);
    const body = await readBody(req);

    const rawCast = body.castCharacterIds;
    const castCharacterIds: string[] = [];
    if (rawCast !== undefined) {
      if (!Array.isArray(rawCast) || rawCast.some((x) => typeof x !== 'string' || !isUuid(x))) {
        throw badRequest('castCharacterIds 必须是 UUID 字符串数组');
      }
      castCharacterIds.push(...(rawCast as string[]));
    }
    // 初始上场名单必须是团队成员
    const members = await repos.troupeMembers.list(id);
    for (const characterId of castCharacterIds) {
      if (!members.includes(characterId)) {
        throw badRequest(`初始上场角色不是团队成员：${characterId}`);
      }
    }

    const session = await repos.sessions.create({
      troupeId: id,
      title: optString(body, 'title', 500),
      scene: optJson(body, 'scene'),
      status: optEnum(body, 'status', ['active', 'archived'] as const),
      settings: optJson(body, 'settings') as never,
    });
    for (const characterId of castCharacterIds) {
      await repos.sessionCast.add(session.id, characterId);
    }
    const openingDraft = await maybeCreateOpeningDraft(repos, session.id);
    return json({ ...session, castCharacterIds, openingDraft }, 201);
  } catch (err) {
    return handleError(err);
  }
}
