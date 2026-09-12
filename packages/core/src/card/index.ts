// Character Card V2/V3 解析与规范化（DESIGN §2.2 Character）、开场草稿（§5.2.2）。
// V2/V3 卡载荷在 data 字段下；V1 扁平字段（description 等在顶层）一并兼容。

import type { Character, MessageSegment } from '../types';
import { substituteMacros, type MacroContext } from './macros';

export interface CharacterCardData {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  alternate_greetings?: string[];
  [key: string]: unknown;
}

/** 解包 V2/V3 的 data 层；非对象输入返回空对象 */
export function cardData(card: unknown): CharacterCardData {
  if (!card || typeof card !== 'object') return {};
  const raw = card as Record<string, unknown>;
  const inner = raw.data;
  if (inner && typeof inner === 'object') return inner as CharacterCardData;
  return raw as CharacterCardData;
}

/** 卡片可扫描文本（§5.2 ② 扫描源之一）：描述/性格/场景/开场/示例对话 */
export function cardText(card: unknown): string {
  const d = cardData(card);
  return [d.description, d.personality, d.scenario, d.first_mes, d.mes_example]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n');
}

function jsonToText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/**
 * 角色卡定义层（§5.2 ③）。includeSecrets 仅在为本角色组装上下文时为 true
 * ——secrets 只注入本人生成上下文（§2.2），对他人组装由调用方传 false。
 */
export function renderCharacterCard(
  char: Pick<Character, 'name' | 'card' | 'secrets'>,
  opts: { includeSecrets?: boolean } = {},
): string {
  const d = cardData(char.card);
  const parts: string[] = [`# ${d.name ?? char.name}`];
  if (d.description) parts.push(d.description);
  if (d.personality) parts.push(`性格：${d.personality}`);
  if (d.scenario) parts.push(`场景：${d.scenario}`);
  if (d.mes_example) parts.push(`对话示例：\n${d.mes_example}`);
  if (opts.includeSecrets) {
    const secrets = jsonToText(char.secrets);
    if (secrets) parts.push(`【只有 ${char.name} 自己知道的秘密设定】\n${secrets}`);
  }
  return parts.join('\n\n');
}

/** 开场候选（§5.2.2）：first_mes 在前，alternate_greetings 随后，供导演挑选 */
export function extractGreetings(card: unknown): string[] {
  const d = cardData(card);
  const greetings: string[] = [];
  if (typeof d.first_mes === 'string' && d.first_mes.length > 0) greetings.push(d.first_mes);
  if (Array.isArray(d.alternate_greetings)) {
    for (const g of d.alternate_greetings) {
      if (typeof g === 'string' && g.length > 0) greetings.push(g);
    }
  }
  return greetings;
}

/**
 * 开场草稿内容（§5.2.2）：宏替换后构造 M1 单 public 段落。
 * greetingIndex 超出范围或卡无开场时抛错，由上层决定是否改用旁白开场。
 */
export function buildOpeningDraftContent(
  card: unknown,
  ctx: MacroContext,
  greetingIndex = 0,
): MessageSegment[] {
  const greetings = extractGreetings(card);
  const greeting = greetings[greetingIndex];
  if (greeting === undefined) {
    throw new Error(
      greetings.length === 0
        ? '角色卡没有 first_mes / alternate_greetings，无法构造开场草稿'
        : `开场索引越界：${greetingIndex}（共 ${greetings.length} 条候选）`,
    );
  }
  return [{ kind: 'action', text: substituteMacros(greeting, ctx), visibility: 'public' }];
}

export { substituteMacros } from './macros';
export type { MacroContext } from './macros';
