// 发言调度（DESIGN §5.4）：导演点名 / 依次反应（严格串行）/ 自动接龙（后续迭代）。
// 本模块为纯函数：批次状态形状见 types.ts 的 ReactionBatch，
// 持久化走 sessions.updateSettings 读写 session.settings.reactionBatch（JSONB）。
//
// 依次反应的严格串行约定（§5.4 v0.4）：A 生成 → 导演确认（A 落盘）→ B 才开始
// 生成。因此 advanceBatch 只能在上一个角色的草稿确认落盘后调用——后续角色的
// 上下文必须包含前面角色已确认的反应，禁止批量并行预生成。本模块无法强制
// 该时序（状态在调用方手里），靠调用顺序保证。
//
// 典型流程（web 层）：
//   const batch = planReactionBatch(castIds, { cap: settings.reactionBatchLimit,
//     triggerMessageId, directive });
//   await sessions.updateSettings(sid, { reactionBatch: batch });
//   → 生成 currentBatchCharacter(batch) 的草稿 → 导演确认 →
//   const next = advanceBatch(batch);
//   next ? 存 next.batch 并生成 next.nextCharacterId
//        : sessions.updateSettings(sid, { reactionBatch: null }) 批次结束

import type { ReactionBatch } from '../types';

export interface PlanReactionBatchOptions {
  /**
   * 批上限：限制队列长度（§5.4：一次导演操作不会触发超额付费调用）。
   * 缺省 = castIds.length（默认 = 在场角色数）；≤ 0 得到空批次。
   */
  cap?: number;
  triggerMessageId?: string;
  directive?: string;
}

/**
 * 生成依次反应批次：队列 = castIds 去重（保序）后按 cap 截断。
 * castIds 为空或 cap ≤ 0 时返回空批次（isBatchActive 为 false）。
 */
export function planReactionBatch(
  castIds: string[],
  options: PlanReactionBatchOptions = {},
): ReactionBatch {
  const deduped = [...new Set(castIds)];
  const cap = options.cap ?? deduped.length;
  const queue = cap >= deduped.length ? deduped : deduped.slice(0, Math.max(0, cap));
  return {
    ...(options.triggerMessageId !== undefined
      ? { triggerMessageId: options.triggerMessageId }
      : {}),
    ...(options.directive !== undefined ? { directive: options.directive } : {}),
    queue,
    currentIndex: 0,
    total: queue.length,
  };
}

/** 当前应生成（或正在等确认）的角色；批次耗尽/空批次返回 null */
export function currentBatchCharacter(batch: ReactionBatch): string | null {
  return batch.queue[batch.currentIndex] ?? null;
}

/**
 * 严格串行推进（§5.4）：上一角色草稿确认落盘后调用。
 * 返回推进后的新批次与下一个发言角色；队列耗尽返回 null（调用方清除
 * settings.reactionBatch）。不改动入参（不可变更新）。
 */
export function advanceBatch(
  batch: ReactionBatch,
): { batch: ReactionBatch; nextCharacterId: string } | null {
  const nextIndex = batch.currentIndex + 1;
  if (nextIndex >= batch.queue.length) return null;
  const next: ReactionBatch = { ...batch, currentIndex: nextIndex };
  return { batch: next, nextCharacterId: next.queue[nextIndex] };
}

/** 批次是否进行中（空批次、越界状态均视为不活跃）；类型谓词便于调用方收窄 */
export function isBatchActive(batch: ReactionBatch | null | undefined): batch is ReactionBatch {
  return (
    batch != null && batch.queue.length > 0 && batch.currentIndex < batch.queue.length
  );
}

export interface BatchProgress {
  /** 1-based：当前角色在队列中的序号（进行中角色）；空批次为 0 */
  current: number;
  total: number;
  /** 当前角色（= currentBatchCharacter） */
  currentCharacterId: string | null;
  /** 含当前角色在内、尚未确认落盘的角色数 */
  remaining: number;
}

/** 进度快照（UI 展示用） */
export function batchProgress(batch: ReactionBatch): BatchProgress {
  const total = batch.queue.length;
  return {
    current: total === 0 ? 0 : Math.min(batch.currentIndex + 1, total),
    total,
    currentCharacterId: currentBatchCharacter(batch),
    remaining: Math.max(0, total - batch.currentIndex),
  };
}
