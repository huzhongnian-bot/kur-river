import { describe, expect, it } from 'vitest';
import {
  entryActivated,
  keyMatches,
  scanLorebook,
  type LorebookScanInput,
} from '../src/lorebook/index';
import { createHeuristicTokenCounter } from '../src/token-counter';
import type { LorebookEntry } from '../src/types';

const counter = createHeuristicTokenCounter();

let seq = 0;
function entry(partial: Partial<LorebookEntry> & { keys: string[] }): LorebookEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    ownerType: 'world',
    ownerId: 'w1',
    visibility: 'public',
    secondaryKeys: null,
    content: `内容-${seq}`,
    position: 'before_char',
    depth: null,
    insertionOrder: 0,
    scanDepth: null,
    tokenBudget: null,
    enabled: true,
    ...partial,
  };
}

function scan(input: Partial<LorebookScanInput> & { entries: LorebookEntry[] }) {
  return scanLorebook({
    sources: input.sources ?? ['扫描源文本'],
    budget: input.budget ?? 1000,
    tokenCounter: counter,
    ...input,
  });
}

describe('世界书引擎：关键词匹配（§5.3 步骤 1）', () => {
  it('子串命中、不区分大小写', () => {
    expect(keyMatches('Dragon', 'a DRAGON appears')).toBe(true);
    expect(keyMatches('龙', '一条 龙 飞过')).toBe(true);
    expect(keyMatches('猫', '一条狗飞过')).toBe(false);
  });

  it('`/.../flags` 形式按正则匹配', () => {
    expect(keyMatches('/dra+gon/i', 'a DRAAGON appears')).toBe(true);
    expect(keyMatches('/^\\d{3}$/', 'abc')).toBe(false);
    expect(keyMatches('/^\\d{3}$/', '123')).toBe(true);
  });

  it('非法正则降级为字面子串', () => {
    expect(keyMatches('/dra(gon/i', '含有 dra(gon 字样')).toBe(true);
  });

  it('keys 数组任一命中即激活；空 keys 不激活', () => {
    expect(entryActivated({ keys: ['a', 'b'], secondaryKeys: null }, ['xbx'])).toBe(true);
    expect(entryActivated({ keys: [], secondaryKeys: null }, ['xbx'])).toBe(false);
  });

  it('secondaryKeys：主副同时命中才激活（ST AND 逻辑）', () => {
    const e = { keys: ['龙'], secondaryKeys: ['洞穴'] };
    expect(entryActivated(e, ['龙出现了'])).toBe(false); // 副 key 未命中
    expect(entryActivated(e, ['洞穴很深'])).toBe(false); // 主 key 未命中
    expect(entryActivated(e, ['龙', '洞穴'])).toBe(true); // 跨扫描源同时命中也算
  });

  it('enabled=false 的条目被过滤', () => {
    const result = scan({
      sources: ['龙'],
      entries: [entry({ keys: ['龙'], enabled: false })],
    });
    expect(result.beforeChar).toHaveLength(0);
  });
});

describe('世界书引擎：排序与预算截断（§5.3 步骤 3-4）', () => {
  it('insertionOrder 数值小者优先进入预算', () => {
    // 每条 content 各 10 token（10 个 CJK 字），预算 15 → 只有小 order 的进
    const low = entry({ keys: ['龙'], content: '一二三四五六七八九十', insertionOrder: 100 });
    const high = entry({ keys: ['龙'], content: '一二三四五六七八九十', insertionOrder: 1 });
    const result = scan({ sources: ['龙'], entries: [low, high], budget: 15 });
    expect(result.beforeChar.map((a) => a.entry.id)).toEqual([high.id]);
  });

  it('放不下的条目跳过、继续尝试更短的后续条目', () => {
    const big = entry({ keys: ['龙'], content: '一'.repeat(20), insertionOrder: 1 });
    const small = entry({ keys: ['龙'], content: '一二三四五', insertionOrder: 2 });
    const result = scan({ sources: ['龙'], entries: [big, small], budget: 10 });
    expect(result.beforeChar.map((a) => a.entry.id)).toEqual([small.id]);
  });
});

describe('世界书引擎：位置分组（§5.3 步骤 5）', () => {
  it('按 position 分 before_char / after_char / at_depth 三组', () => {
    const before = entry({ keys: ['龙'], position: 'before_char' });
    const after = entry({ keys: ['龙'], position: 'after_char' });
    const atDepth = entry({ keys: ['龙'], position: 'at_depth', depth: 2 });
    const result = scan({ sources: ['龙'], entries: [before, after, atDepth] });
    expect(result.beforeChar.map((a) => a.entry.id)).toEqual([before.id]);
    expect(result.afterChar.map((a) => a.entry.id)).toEqual([after.id]);
    expect(result.atDepth.map((a) => a.entry.id)).toEqual([atDepth.id]);
    expect(result.atDepth[0].entry.depth).toBe(2);
  });

  it('输出携带每条计入预算的 token 数', () => {
    const e = entry({ keys: ['龙'], content: '一二三四五六七八九十' });
    const result = scan({ sources: ['龙'], entries: [e] });
    expect(result.beforeChar[0].tokens).toBe(10);
  });
});
