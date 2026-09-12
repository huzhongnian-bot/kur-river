// 世界书引擎（DESIGN §5.3 MVP 子集）：关键词匹配（子串、不区分大小写；
// `/.../flags` 形式按正则）、secondaryKeys 主副 AND、insertionOrder 小者
// 优先进预算、token 预算截断、按 position 分三组输出。
// 递归扫描、概率触发、timed effects（sticky/cooldown）列入后续迭代，不在此实现。

import type { TokenCounter } from '@kur-river/llm';
import type { LorebookEntry, LorebookPosition } from '../types';

export interface LorebookScanInput {
  /** 扫描源文本集合（§5.2 ②：最近可见消息 publicText + 卡文本 + directive） */
  sources: string[];
  /** 候选条目（调用方已按 scope/visibility 过滤；enabled=false 在此兜底过滤） */
  entries: LorebookEntry[];
  /** 世界书 token 预算（来自 allocateBudget） */
  budget: number;
  tokenCounter: TokenCounter;
  /** tokenizer 提示（§10.3 估算器可忽略） */
  model?: string;
}

export interface ActivatedEntry {
  entry: LorebookEntry;
  /** 该条目 content 计入预算的 token 数 */
  tokens: number;
}

export interface LorebookScanResult {
  beforeChar: ActivatedEntry[];
  afterChar: ActivatedEntry[];
  /** position=at_depth，带 depth（缺省 1），供历史层按深度插桩（§5.2 ⑤） */
  atDepth: ActivatedEntry[];
}

const REGEX_KEY = /^\/(.+)\/([a-z]*)$/;

/** 单个 key 命中判定：`/pattern/flags` 按正则（非法正则降级为字面子串），否则子串不区分大小写 */
export function keyMatches(key: string, haystack: string): boolean {
  const asRegex = REGEX_KEY.exec(key);
  if (asRegex) {
    try {
      return new RegExp(asRegex[1], asRegex[2]).test(haystack);
    } catch {
      // 非法正则：降级为去掉斜杠后的字面匹配
      return haystack.toLowerCase().includes(asRegex[1].toLowerCase());
    }
  }
  return haystack.toLowerCase().includes(key.toLowerCase());
}

function anyKeyMatches(keys: readonly string[], haystacks: readonly string[]): boolean {
  return keys.some((key) => haystacks.some((h) => keyMatches(key, h)));
}

/** 条目激活判定：主 key 命中；带 secondaryKeys 时需主副同时命中（ST AND 逻辑） */
export function entryActivated(
  entry: Pick<LorebookEntry, 'keys' | 'secondaryKeys'>,
  haystacks: readonly string[],
): boolean {
  if (entry.keys.length === 0) return false;
  if (!anyKeyMatches(entry.keys, haystacks)) return false;
  const secondary = entry.secondaryKeys ?? [];
  if (secondary.length > 0 && !anyKeyMatches(secondary, haystacks)) return false;
  return true;
}

/** 扫描主入口：匹配 → insertionOrder 升序 → 预算截断 → 按 position 分组（§5.3） */
export function scanLorebook(input: LorebookScanInput): LorebookScanResult {
  const haystacks = input.sources.filter((s) => typeof s === 'string' && s.length > 0);

  const matched = input.entries
    .filter((e) => e.enabled)
    .filter((e) => entryActivated(e, haystacks));

  // insertionOrder 数值小者优先进入预算（§5.3 步骤 3）；同序保持传入顺序
  matched.sort((a, b) => a.insertionOrder - b.insertionOrder);

  const result: LorebookScanResult = { beforeChar: [], afterChar: [], atDepth: [] };
  let used = 0;
  for (const entry of matched) {
    const tokens = input.tokenCounter.countText(entry.content, input.model);
    // 预算截断：放不下的条目跳过，继续尝试后续（可能更短的）条目
    if (used + tokens > input.budget) continue;
    used += tokens;
    const activated: ActivatedEntry = { entry, tokens };
    const position: LorebookPosition = entry.position;
    if (position === 'before_char') result.beforeChar.push(activated);
    else if (position === 'after_char') result.afterChar.push(activated);
    else result.atDepth.push(activated);
  }
  return result;
}

/** 便于注入的纯文本视图 */
export function activatedContents(entries: ActivatedEntry[]): string[] {
  return entries.map((a) => a.entry.content);
}
