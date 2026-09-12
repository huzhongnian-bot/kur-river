// /api/drafts/:id/regenerate —— 重抽（§5.6）：新 draft 替换旧，
// 缺省沿用旧草稿的模型配置快照；body 带 connectionId/model/presetId 时重新解析覆盖。
// 旧草稿为 ready 态时置 discarded（failed 态无出边，保留记录）。
import { canTransitionDraft, regenerateDraft, transitionDraft } from '@kur-river/core';
import { getRepos } from '@/server/repos';
import { kickGeneration, resolveSnapshot } from '@/server/generation';
import { badRequest, handleError, json, notFound, type RouteCtx } from '@/server/http';
import { optString, optUuid, pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    const source = await repos.drafts.get(id);
    if (!source) throw notFound(`草稿不存在：${id}`);
    if (source.status !== 'ready' && source.status !== 'failed') {
      throw badRequest(`仅 ready / failed 态草稿可重抽（当前 ${source.status}）`);
    }

    // 重抽允许空 body（纯沿用）；有 body 时取可选覆盖字段
    const raw = await req.text();
    let body: Record<string, unknown> = {};
    if (raw.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw badRequest('请求体不是合法 JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw badRequest('请求体必须是 JSON 对象');
      }
      body = parsed as Record<string, unknown>;
    }
    const connectionId = optUuid(body, 'connectionId') ?? undefined;
    const model = optString(body, 'model', 200) ?? undefined;
    const presetId = optUuid(body, 'presetId') ?? undefined;
    const directive = optString(body, 'directive');

    // 带覆盖字段 → 重新解析快照；否则沿用旧快照（§5.6 A/B 对比语义）
    let snapshot;
    if (connectionId !== undefined || model !== undefined || presetId !== undefined) {
      try {
        snapshot = await resolveSnapshot(repos, {
          sessionId: source.sessionId,
          characterId: source.characterId,
          connectionId,
          model,
          presetId,
        });
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
    }

    const draft = await regenerateDraft(repos, id, {
      ...(directive !== undefined ? { directive } : {}),
      ...(snapshot ?? {}),
    });
    if (canTransitionDraft(source.status, 'discarded')) {
      await transitionDraft(repos, id, 'discarded');
    }
    kickGeneration(draft.id);
    return json(draft, 201);
  } catch (err) {
    return handleError(err);
  }
}
