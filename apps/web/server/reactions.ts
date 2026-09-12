// 依次反应（DESIGN §5.4，严格串行）：批次计划/推进的服务端编排。
// 状态存 session.settings.reactionBatch（core scheduling 纯函数读写形状，
// 持久化走 sessions.updateSettings；patch 值传 null 清键）。
//
// 严格串行的挂接点：confirm / discard 路由在草稿状态落定后调用
// advanceReactionBatchAfterDraft —— 刚落盘（或被跳过）的草稿属于批次当前
// 角色时才 advanceBatch，并为下一角色建生成草稿（后续角色的上下文必须
// 包含前面角色已确认的反应，禁止批量并行预生成）。
import {
  advanceBatch,
  currentBatchCharacter,
  isBatchActive,
  planReactionBatch,
  type Draft,
  type ReactionBatch,
  type Repos,
} from '@kur-river/core';
import { getEventBus } from './events';
import { kickGeneration, resolveSnapshot } from './generation';

/** 为批次当前角色建生成草稿（复用常规管线：模型快照解析 + 进程内异步生成） */
async function createBatchDraft(
  repos: Repos,
  sessionId: string,
  batch: ReactionBatch,
  characterId: string,
): Promise<Draft> {
  const snapshot = await resolveSnapshot(repos, { sessionId, characterId });
  const draft = await repos.drafts.create({
    sessionId,
    characterId,
    directive: batch.directive ?? null,
    triggerMessageId: batch.triggerMessageId ?? null,
    ...snapshot,
  });
  getEventBus().emit('draft.created', { draft });
  kickGeneration(draft.id);
  return draft;
}

export interface StartReactionBatchInput {
  directive?: string | null;
  triggerMessageId?: string | null;
  /** 在场名单的子集；缺省 = 全部在场角色。队列顺序始终按在场名单顺序 */
  characterIds?: string[];
  /** 批上限；缺省回退场次设置 reactionBatchLimit，再缺省 = 队列长度 */
  cap?: number;
}

export type StartReactionBatchResult =
  | { ok: true; batch: ReactionBatch; draft: Draft }
  | { ok: false; status: 400 | 409; message: string };

/** POST /reactions：无活跃批次才允许发起（有则 409）；plan → 持久化 → 首角色建草稿 */
export async function startReactionBatch(
  repos: Repos,
  sessionId: string,
  input: StartReactionBatchInput,
): Promise<StartReactionBatchResult> {
  const session = await repos.sessions.get(sessionId);
  if (!session) return { ok: false, status: 400, message: `场次不存在：${sessionId}` };
  const existing = session.settings?.reactionBatch;
  if (isBatchActive(existing)) {
    return { ok: false, status: 409, message: '已有进行中的依次反应批次（先确认/放弃当前草稿或取消批次）' };
  }

  const castIds = await repos.sessionCast.list(sessionId);
  // 队列顺序以在场名单为准；characterIds 只是在场名单上的过滤（§5.4 列表顺序推进）
  if (input.characterIds) {
    const outsider = input.characterIds.find((id) => !castIds.includes(id));
    if (outsider) {
      return { ok: false, status: 400, message: `反应角色不在在场名单中：${outsider}` };
    }
  }
  const queueBase = input.characterIds
    ? castIds.filter((id) => input.characterIds!.includes(id))
    : castIds;
  const cap = input.cap ?? session.settings?.reactionBatchLimit;
  const batch = planReactionBatch(queueBase, {
    ...(cap !== undefined ? { cap } : {}),
    ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
    ...(input.directive ? { directive: input.directive } : {}),
  });
  const first = currentBatchCharacter(batch);
  if (!first) return { ok: false, status: 400, message: '反应批次为空（在场名单/角色子集无可反应角色）' };

  await repos.sessions.updateSettings(sessionId, { reactionBatch: batch });
  const draft = await createBatchDraft(repos, sessionId, batch, first);
  return { ok: true, batch, draft };
}

export interface AdvanceReactionResult {
  /** 是否发生了批次推进/收尾（草稿不属于批次当前角色时为 false） */
  touched: boolean;
  /** 批次已耗尽并清除 */
  finished: boolean;
  /** 推进后为下一角色建的草稿（finished 时无） */
  nextDraft?: Draft;
}

/**
 * confirm / discard 共用挂接（§5.4 严格串行 + discard 视为跳过）：
 * 该草稿的角色 == 批次当前角色才推进；有下一角色则建草稿，耗尽则清批次。
 */
export async function advanceReactionBatchAfterDraft(
  repos: Repos,
  draft: Pick<Draft, 'sessionId' | 'characterId'>,
): Promise<AdvanceReactionResult> {
  const session = await repos.sessions.get(draft.sessionId);
  const batch = session?.settings?.reactionBatch;
  if (!isBatchActive(batch)) return { touched: false, finished: false };
  if (currentBatchCharacter(batch) !== draft.characterId) {
    return { touched: false, finished: false };
  }

  const advanced = advanceBatch(batch);
  if (!advanced) {
    await repos.sessions.updateSettings(draft.sessionId, { reactionBatch: null });
    return { touched: true, finished: true };
  }
  await repos.sessions.updateSettings(draft.sessionId, { reactionBatch: advanced.batch });
  const nextDraft = await createBatchDraft(
    repos,
    draft.sessionId,
    advanced.batch,
    advanced.nextCharacterId,
  );
  return { touched: true, finished: false, nextDraft };
}

/** POST /reactions/cancel：清批次；已生成的当前草稿保留可处置 */
export async function cancelReactionBatch(repos: Repos, sessionId: string): Promise<boolean> {
  const session = await repos.sessions.get(sessionId);
  const wasActive = isBatchActive(session?.settings?.reactionBatch);
  if (wasActive) await repos.sessions.updateSettings(sessionId, { reactionBatch: null });
  return wasActive;
}
