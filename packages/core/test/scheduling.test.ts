// 依次反应调度纯函数测试（§5.4：严格串行、批上限）
import { describe, expect, it } from 'vitest';
import {
  advanceBatch,
  batchProgress,
  currentBatchCharacter,
  isBatchActive,
  planReactionBatch,
} from '../src/scheduling/index';
import type { ReactionBatch } from '../src/types';

describe('planReactionBatch（§5.4：cap 限制队列长度，默认 = 在场人数）', () => {
  it('缺省 cap = castIds.length，currentIndex 从 0 开始', () => {
    const b = planReactionBatch(['a', 'b', 'c']);
    expect(b).toEqual({ queue: ['a', 'b', 'c'], currentIndex: 0, total: 3 });
  });

  it('cap 收紧队列；cap 大于人数不扩充；cap ≤ 0 得空批次', () => {
    expect(planReactionBatch(['a', 'b', 'c'], { cap: 2 }).queue).toEqual(['a', 'b']);
    expect(planReactionBatch(['a', 'b'], { cap: 99 }).queue).toEqual(['a', 'b']);
    const empty = planReactionBatch(['a', 'b'], { cap: 0 });
    expect(empty.queue).toEqual([]);
    expect(empty.total).toBe(0);
    expect(isBatchActive(empty)).toBe(false);
  });

  it('castIds 去重保序；空名单得空批次', () => {
    expect(planReactionBatch(['a', 'b', 'a', 'c', 'b']).queue).toEqual(['a', 'b', 'c']);
    expect(isBatchActive(planReactionBatch([]))).toBe(false);
  });

  it('triggerMessageId / directive 记入批次（供批次内各角色生成共用）', () => {
    const b = planReactionBatch(['a'], { triggerMessageId: 'm1', directive: '继续' });
    expect(b.triggerMessageId).toBe('m1');
    expect(b.directive).toBe('继续');
    // 不传则不出现该键（JSONB 存储友好）
    const bare = planReactionBatch(['a']);
    expect('triggerMessageId' in bare).toBe(false);
    expect('directive' in bare).toBe(false);
  });
});

describe('advanceBatch（§5.4 严格串行：上一草稿确认后才推进）', () => {
  it('按队列顺序逐一给出下一角色，耗尽返回 null', () => {
    const b0 = planReactionBatch(['a', 'b', 'c'], { directive: 'd' });
    expect(currentBatchCharacter(b0)).toBe('a');

    const s1 = advanceBatch(b0);
    expect(s1?.nextCharacterId).toBe('b');
    expect(s1?.batch.currentIndex).toBe(1);
    expect(s1?.batch.directive).toBe('d'); // 元数据随批次携带

    const s2 = advanceBatch(s1!.batch);
    expect(s2?.nextCharacterId).toBe('c');

    expect(advanceBatch(s2!.batch)).toBeNull();
  });

  it('不可变更新：入参批次不被改动', () => {
    const b = planReactionBatch(['a', 'b']);
    advanceBatch(b);
    expect(b.currentIndex).toBe(0);
  });

  it('单角色批次推进一次即耗尽；空批次直接 null', () => {
    const single = planReactionBatch(['a']);
    expect(advanceBatch(single)).toBeNull();
    expect(advanceBatch(planReactionBatch([]))).toBeNull();
  });
});

describe('isBatchActive / batchProgress', () => {
  it('进行中为 true；null/undefined/空批次为 false', () => {
    expect(isBatchActive(planReactionBatch(['a']))).toBe(true);
    expect(isBatchActive(null)).toBe(false);
    expect(isBatchActive(undefined)).toBe(false);
    expect(isBatchActive(planReactionBatch([], { cap: 0 }))).toBe(false);
  });

  it('进度快照：1-based 序号 + 剩余数；推进中实时变化', () => {
    const b = planReactionBatch(['a', 'b', 'c']);
    expect(batchProgress(b)).toEqual({
      current: 1,
      total: 3,
      currentCharacterId: 'a',
      remaining: 3,
    });
    const next = advanceBatch(b)!.batch;
    expect(batchProgress(next)).toEqual({
      current: 2,
      total: 3,
      currentCharacterId: 'b',
      remaining: 2,
    });
  });

  it('异常状态（currentIndex 越界）不活跃且进度钳位', () => {
    const corrupt: ReactionBatch = { queue: ['a'], currentIndex: 5, total: 1 };
    expect(isBatchActive(corrupt)).toBe(false);
    expect(currentBatchCharacter(corrupt)).toBeNull();
    const p = batchProgress(corrupt);
    expect(p.current).toBe(1); // 钳位到 total
    expect(p.remaining).toBe(0);
  });
});
