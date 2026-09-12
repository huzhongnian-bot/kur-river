// 草稿清理（M3 归档/截断重演共用）：统一 discard 场次内悬挂草稿。
// generating 态由状态机的系统级取消边处理（core/draft：生成任务落地前复查静默终止）。
import { canTransitionDraft, transitionDraft, type DraftStatus, type Repos } from '@kur-river/core';

const HANGING: readonly DraftStatus[] = ['queued', 'generating', 'ready'];

/** 把该场次 queued/generating/ready 草稿统一置 discarded，返回处理条数 */
export async function discardHangingDrafts(repos: Repos, sessionId: string): Promise<number> {
  const drafts = await repos.drafts.listBySession(sessionId);
  let count = 0;
  for (const draft of drafts) {
    if (!HANGING.includes(draft.status)) continue;
    if (!canTransitionDraft(draft.status, 'discarded')) continue;
    await transitionDraft(repos, draft.id, 'discarded');
    count++;
  }
  return count;
}
