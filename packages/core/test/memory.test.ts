import { describe, expect, it } from 'vitest';
import {
  buildMemoryLayer,
  DEFAULT_MEMORY_MERGE_THRESHOLD,
  selectRecordsForEpoch,
  shouldRebuildEpoch,
} from '../src/memory/index';
import { createHeuristicTokenCounter } from '../src/token-counter';
import type { MemoryRecord } from '../src/types';

const counter = createHeuristicTokenCounter();

let seq = 0;
function record(partial: Partial<MemoryRecord> = {}): MemoryRecord {
  seq += 1;
  return {
    id: `m${seq}`,
    characterId: 'c1',
    troupeId: 't1',
    sessionId: `s${seq}`,
    kind: 'session',
    coversCount: null,
    summary: `摘要${seq}`,
    createdAt: new Date(seq * 1000),
    ...partial,
  };
}

describe('epoch 触发与选择（§2.2 Memory 滚动合并）', () => {
  it('条数 ≤ 阈值不触发；> 阈值触发', () => {
    expect(shouldRebuildEpoch(10, 10)).toBe(false);
    expect(shouldRebuildEpoch(11, 10)).toBe(true);
    expect(shouldRebuildEpoch(4, 3)).toBe(true);
    expect(shouldRebuildEpoch(3, 3)).toBe(false);
  });

  it('selectRecordsForEpoch：保留最新 threshold 条，最旧的并入 epoch', () => {
    const records = Array.from({ length: 5 }, () => record());
    const covered = selectRecordsForEpoch(records, 3);
    expect(covered.map((r) => r.id)).toEqual([records[0].id, records[1].id]);
    expect(selectRecordsForEpoch(records, 10)).toEqual([]);
  });

  it('默认阈值为 10（§2.2 例值）', () => {
    expect(DEFAULT_MEMORY_MERGE_THRESHOLD).toBe(10);
  });
});

describe('buildMemoryLayer（§5.2 ④：最近优先，升序呈现）', () => {
  it('预算内从旧到新截断：最新优先保留，输出按时间升序', () => {
    // 每条"摘要N"≈3 token（2 CJK + 1 digit→ceil(1/4)=1）；预算 7 → 最新两条
    const records = Array.from({ length: 4 }, () => record());
    const result = buildMemoryLayer({ records, budgetTokens: 7, tokenCounter: counter });
    expect(result.used.map((r) => r.id)).toEqual([records[2].id, records[3].id]);
    expect(result.text).toBe(`${records[2].summary}\n\n${records[3].summary}`);
  });

  it('至少保留一条（最新记录超预算也带）', () => {
    const records = [record()];
    const result = buildMemoryLayer({ records, budgetTokens: 0, tokenCounter: counter });
    expect(result.used).toHaveLength(1);
    expect(result.text).toBe(records[0].summary);
  });

  it('epoch 替代被覆盖的原始记录：跳过前 coversCount 条，epoch 作为最旧条目', () => {
    const sessions = Array.from({ length: 4 }, () => record());
    const epoch = record({
      kind: 'epoch',
      coversCount: 2,
      summary: '早期综合记忆',
      createdAt: new Date(500),
    });
    const result = buildMemoryLayer({
      records: [...sessions, epoch],
      budgetTokens: 1000,
      tokenCounter: counter,
    });
    expect(result.used.map((r) => r.summary)).toEqual([
      '早期综合记忆',
      sessions[2].summary,
      sessions[3].summary,
    ]);
  });

  it('epoch 与被覆盖记录一起参与"最新优先"预算截断', () => {
    const sessions = Array.from({ length: 4 }, () => record());
    const epoch = record({ kind: 'epoch', coversCount: 2, summary: '早期综合记忆' });
    // 预算只够最新两条 → epoch 被截掉
    const result = buildMemoryLayer({
      records: [...sessions, epoch],
      budgetTokens: 7,
      tokenCounter: counter,
    });
    expect(result.used.map((r) => r.id)).toEqual([sessions[2].id, sessions[3].id]);
  });

  it('无记忆 → 空文本；coversCount 失效（覆盖全部）时 epoch 仍作唯一条目', () => {
    expect(buildMemoryLayer({ records: [], budgetTokens: 100, tokenCounter: counter }).text).toBe('');
    const epochOnly = record({ kind: 'epoch', coversCount: 5, summary: '唯一记忆' });
    const result = buildMemoryLayer({ records: [epochOnly], budgetTokens: 100, tokenCounter: counter });
    expect(result.text).toBe('唯一记忆');
  });
});
