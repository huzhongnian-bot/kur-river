// 记忆摘要策略（DESIGN §2.2 Memory、§5.2 ④）：纯逻辑，可单测。
// - 生成时按 (character, troupe) 取全部摘要，拼接进 system2；
//   记忆预算内"从旧到新截断（最近场次优先保留）"：从最新向前累计，再按
//   场次时间升序呈现。
// - 滚动合并：session 摘要条数超阈值（默认 10）时，最旧的若干条合并为一条
//   epoch 摘要。**epoch 只是读取优化，不删原始记录**（§2.2 v0.4）——
//   本模块的 selectRecordsForEpoch 给出"哪些原始记录并入 epoch"，
//   buildMemoryLayer 在读取时跳过它们（取 epoch 文本替代）。

import type { TokenCounter } from '@kur-river/llm';
import type { MemoryRecord } from '../types';

/** "摘要的摘要"触发阈值（§2.2 例值 10）；场次 settings.memoryMergeThreshold 可覆盖 */
export const DEFAULT_MEMORY_MERGE_THRESHOLD = 10;

/** 是否该（重）建 epoch：session 摘要条数超过阈值 */
export function shouldRebuildEpoch(
  sessionRecordCount: number,
  threshold: number = DEFAULT_MEMORY_MERGE_THRESHOLD,
): boolean {
  return sessionRecordCount > Math.max(1, threshold);
}

/**
 * 选出并入 epoch 的最旧 session 记录（升序输入的前 N 条）。
 * 规则：保留最新 threshold 条原始记录，之前的全部并入 epoch。
 */
export function selectRecordsForEpoch(
  sessionRecords: MemoryRecord[],
  threshold: number = DEFAULT_MEMORY_MERGE_THRESHOLD,
): MemoryRecord[] {
  if (!shouldRebuildEpoch(sessionRecords.length, threshold)) return [];
  return sessionRecords.slice(0, sessionRecords.length - Math.max(1, threshold));
}

export interface MemoryLayerInput {
  /** 本角色 × 本团队的全部记忆记录（须按**场次时间升序**——MemoryRepo.list 即此约定） */
  records: MemoryRecord[];
  /** 记忆层 token 预算（allocateBudget 的 system 区子预算） */
  budgetTokens: number;
  tokenCounter: TokenCounter;
  model?: string;
}

export interface MemoryLayerResult {
  /** 注入 system2 的记忆文本（升序拼接）；无记忆或预算耗尽为空串 */
  text: string;
  /** 实际纳入的记录（升序） */
  used: MemoryRecord[];
}

/**
 * §5.2 ④ 长期记忆层：
 * 1. 若有 epoch：其覆盖的前 coversCount 条 session 记录以 epoch 文本替代
 *    （epoch 视为最旧的一条）；
 * 2. 预算内从最新向前累计（最近场次优先保留），再按时间升序拼接。
 * 至少保留一条（最新记录即使超预算也带——与历史层的"至少一条"同约定）。
 */
export function buildMemoryLayer(input: MemoryLayerInput): MemoryLayerResult {
  const sessions = input.records.filter((r) => r.kind !== 'epoch');
  const epoch = input.records
    .filter((r) => r.kind === 'epoch')
    .sort((a, b) => (b.coversCount ?? 0) - (a.coversCount ?? 0))[0];

  const candidates: MemoryRecord[] = [];
  if (epoch) {
    const covered = Math.max(0, epoch.coversCount ?? 0);
    if (covered < sessions.length) {
      // epoch 有效（仍有被其覆盖的原始记录）；失效（覆盖数为 0 或覆盖全部时
      // 仅剩 epoch 自身）也照常作为最旧条目参与
      candidates.push(epoch, ...sessions.slice(covered));
    } else {
      candidates.push(epoch);
    }
  } else {
    candidates.push(...sessions);
  }

  const picked: MemoryRecord[] = [];
  let used = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const record = candidates[i];
    const tokens = input.tokenCounter.countText(record.summary, input.model);
    if (picked.length > 0 && used + tokens > input.budgetTokens) break;
    picked.unshift(record);
    used += tokens;
  }
  return {
    text: picked.map((r) => r.summary).join('\n\n'),
    used: picked,
  };
}
