// /api/drafts/:id/discard —— 放弃草稿（§2.2 状态机：queued/generating/ready → discarded）
// 依次反应挂接（§5.4）：discard 视为跳过——批次当前角色的草稿被放弃时同样推进。
import { transitionDraft, DraftTransitionError } from '@kur-river/core';
import { getRepos } from '@/server/repos';
import { advanceReactionBatchAfterDraft } from '@/server/reactions';
import { badRequest, handleError, json, type RouteCtx } from '@/server/http';
import { pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    const draft = await transitionDraft(repos, id, 'discarded');
    const reaction = await advanceReactionBatchAfterDraft(repos, draft);
    return json({ ...draft, reaction });
  } catch (err) {
    if (err instanceof DraftTransitionError) return handleError(badRequest(err.message));
    return handleError(err);
  }
}