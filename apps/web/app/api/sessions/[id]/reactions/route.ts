// /api/sessions/:id/reactions —— 发起依次反应批次（§5.4，严格串行）。
// POST { directive?, triggerMessageId?, characterIds?, cap? }：
// 无活跃批次才允许（有则 409）→ 按在场名单顺序（或 characterIds 子集）
// planReactionBatch → settings.reactionBatch 持久化 → 为当前角色建生成草稿。
// 后续角色在 confirm/discard 挂接中逐一推进（见 server/reactions.ts）。
import { batchProgress } from '@kur-river/core';
import { getRepos } from '@/server/repos';
import { startReactionBatch } from '@/server/reactions';
import { badRequest, conflict, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { isUuid, optNumber, optString, optStringArray, optUuid, pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.sessions.get(id))) throw notFound(`场次不存在：${id}`);

    const body = await readBody(req);
    const triggerMessageId = optUuid(body, 'triggerMessageId');
    if (triggerMessageId) {
      const msg = await repos.messages.get(triggerMessageId);
      if (!msg || msg.sessionId !== id) {
        throw badRequest(`触发消息不存在或不属于本场次：${triggerMessageId}`);
      }
    }
    const characterIdsRaw = optStringArray(body, 'characterIds');
    if (characterIdsRaw) {
      const bad = characterIdsRaw.find((v) => !isUuid(v));
      if (bad) throw badRequest(`字段 characterIds 含非法 UUID：${bad}`);
    }

    const result = await startReactionBatch(repos, id, {
      directive: optString(body, 'directive'),
      triggerMessageId,
      characterIds: characterIdsRaw ?? undefined,
      cap: optNumber(body, 'cap', { int: true, min: 1 }) ?? undefined,
    });
    if (!result.ok) {
      throw result.status === 409 ? conflict(result.message) : badRequest(result.message);
    }
    return json({ batch: result.batch, progress: batchProgress(result.batch), draft: result.draft }, 201);
  } catch (err) {
    return handleError(err);
  }
}
