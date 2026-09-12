// /api/sessions/:id/drafts —— 生成草稿（§5.6）。
// POST：解析模型快照（§5.5）→ 创建 queued 草稿 → 进程内异步生成，立即返回草稿。
// 导演指令 directive 只存草稿、不落盘为消息（§2.2 导演指令不落盘）。
import { getRepos } from '@/server/repos';
import { getEventBus } from '@/server/events';
import { isOutputTruncated, kickGeneration, resolveSnapshot } from '@/server/generation';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { optString, optUuid, pathUuid, reqUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.sessions.get(id))) throw notFound(`场次不存在：${id}`);
    // 派生 outputTruncated 提示位（§5.7 ② 越权截断标记，进程内登记）
    const drafts = (await repos.drafts.listBySession(id)).map((d) => ({
      ...d,
      outputTruncated: isOutputTruncated(d.id),
    }));
    return json(drafts);
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    const session = await repos.sessions.get(id);
    if (!session) throw notFound(`场次不存在：${id}`);

    const body = await readBody(req);
    const characterId = reqUuid(body, 'characterId');
    // 发言角色须在场（§5.4 导演点名的对象是在场角色）
    const castIds = await repos.sessionCast.list(id);
    if (!castIds.includes(characterId)) {
      throw badRequest(`发言角色不在在场名单中：${characterId}`);
    }

    // 生成前解析模型配置快照（§5.5）；解析失败在入队前直接 400
    let snapshot;
    try {
      snapshot = await resolveSnapshot(repos, {
        sessionId: id,
        characterId,
        connectionId: optUuid(body, 'connectionId') ?? undefined,
        model: optString(body, 'model', 200) ?? undefined,
        presetId: optUuid(body, 'presetId') ?? undefined,
      });
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }

    const draft = await repos.drafts.create({
      sessionId: id,
      characterId,
      directive: optString(body, 'directive'),
      triggerMessageId: optUuid(body, 'triggerMessageId'),
      ...snapshot,
    });
    getEventBus().emit('draft.created', { draft });
    kickGeneration(draft.id);
    return json(draft, 201);
  } catch (err) {
    return handleError(err);
  }
}
