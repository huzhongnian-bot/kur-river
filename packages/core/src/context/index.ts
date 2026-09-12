// ContextAssembler：生成上下文组装（DESIGN §5.2）。
// 步骤：①基调世界观层 → ②世界书扫描（三级 scope + castPublicScopes）→
// ③角色卡（含 secrets）→ ④memory 层（M3 才有数据，接口留好）→
// ⑤历史（粗筛+段落渲染，at_depth 按深度插桩）→ ⑥directive 收尾 +
// 输出契约注入第二个 system 消息（§5.7 ①，见 contract/）。
// 宏替换只作用 system 层与 directive（"库里不存裸宏"）。
// role 映射按 §5.2.1："以发言者为第一人称"。

import type { ChatMessage, TokenCounter } from '@kur-river/llm';
import { substituteMacros } from '../card/index';
import { renderCharacterCard, cardText } from '../card/index';
import { scanLorebook, activatedContents, type LorebookScanResult } from '../lorebook/index';
import { buildMemoryLayer } from '../memory/index';
import type { LorebookScope, Repos } from '../repos/index';
import type { Character, LorebookEntry, Message, Persona } from '../types';
import { messagePublicText, renderMessageForReader } from '../visibility/index';

// §5.7 ① 输出契约文本与 ② 解析器同居 contract/（二者必须同步演进）；
// 此处 re-export 保持 M1 既有引用路径不变
export { DEFAULT_OUTPUT_CONTRACT } from '../contract/index';
import { DEFAULT_OUTPUT_CONTRACT } from '../contract/index';

/** §5.1 生成请求：connectionId/model/presetId 为单次覆盖（§5.5 最高层） */
export interface GenerationRequest {
  sessionId: string;
  speakerCharacterId: string;
  directive?: string;
  triggerMessageId?: string;
  connectionId?: string;
  model?: string;
  presetId?: string;
}

// ---------------------------------------------------------------------------
// 预算分配（§5.2）：默认 system 30% / history 50% / 输出保留 20%
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_CONTEXT = 32768;

export interface BudgetRatios {
  system: number;
  history: number;
  output: number;
}

export const DEFAULT_BUDGET_RATIOS: BudgetRatios = {
  system: 0.3,
  history: 0.5,
  output: 0.2,
};

export interface BudgetAllocation {
  maxContext: number;
  /** system 区总预算（①②③④⑥ 之和的上限参考值） */
  system: number;
  /** 历史区预算（⑤） */
  history: number;
  /** 输出保留（不用于组装，供调用方设置 maxTokens 上限参考） */
  outputReserve: number;
  /** 世界书预算：system 区的一半（设计未指定份额，M1 取 1/2，可经 ratios 调整） */
  lorebook: number;
  /** 长期记忆预算（§5.2 ④）：与 lorebook 并列的 system 区子预算，
   *  M3 取 system 的 1/4（卡片/基调保底不动，记忆不足时从旧截断） */
  memory: number;
}

export function allocateBudget(
  maxContext: number = DEFAULT_MAX_CONTEXT,
  ratios: BudgetRatios = DEFAULT_BUDGET_RATIOS,
): BudgetAllocation {
  const total = Math.max(0, Math.floor(maxContext));
  const system = Math.floor(total * ratios.system);
  const history = Math.floor(total * ratios.history);
  // 输出保留吃掉舍入误差，确保三区之和 == maxContext
  const outputReserve = Math.max(0, total - system - history);
  return {
    maxContext: total,
    system,
    history,
    outputReserve,
    lorebook: Math.floor(system / 2),
    memory: Math.floor(system / 4),
  };
}

// ---------------------------------------------------------------------------
// role 映射（§5.2.1）
// ---------------------------------------------------------------------------

/** 历史消息发送者的展示名解析 */
export interface SenderNames {
  character(id: string): string | undefined;
  persona(id: string): string | undefined;
}

export const DIRECTOR_DISPLAY_NAME = '旁白';

export function senderDisplayName(message: Message, names: SenderNames): string {
  if (message.senderType === 'character') {
    return (message.senderId && names.character(message.senderId)) || '角色';
  }
  if (message.senderType === 'player') {
    return (message.senderId && names.persona(message.senderId)) || '玩家';
  }
  return DIRECTOR_DISPLAY_NAME;
}

/**
 * 多角色历史的 role 映射（§5.2.1）：
 * - 发言角色自己的消息 → assistant（不加名字前缀，第一人称）
 * - 其他角色 / 导演旁白 / 玩家化身 → user，内容加 "名字: " 前缀
 * - 段落渲染在映射前完成（§2.3 第二级过滤）；渲染后为空则整条跳过
 */
export function historyMessageToChat(
  message: Message,
  readerCharacterId: string,
  names: SenderNames,
): ChatMessage | null {
  const segments = renderMessageForReader(message, readerCharacterId);
  if (segments.length === 0) return null;
  const text = segments.map((s) => s.text).join('\n');
  const isOwn =
    message.senderType === 'character' && message.senderId === readerCharacterId;
  if (isOwn) return { role: 'assistant', content: text };
  return { role: 'user', content: `${senderDisplayName(message, names)}: ${text}` };
}

// ---------------------------------------------------------------------------
// directive 收尾与世界书 scope 辅助
// ---------------------------------------------------------------------------

export function wrapDirective(directive: string): string {
  return `[导演指令] ${directive}`;
}

/**
 * §5.2 ② castPublicScopes：其他在场角色的 character 级 scope。
 * 这些 scope 下的 **public** 条目对本次扫描生效（§2.2：public 条目"在该角色
 * 在场时对所有发言者的扫描生效"）；private 条目由调用方过滤掉。
 * 本人 scope 不在此列（本人 public+private 都生效，由调用方单独加）。
 */
export function castPublicScopes(castIds: string[], speakerId: string): LorebookScope[] {
  return castIds
    .filter((id) => id !== speakerId)
    .map((ownerId) => ({ ownerType: 'character' as const, ownerId }));
}

// ---------------------------------------------------------------------------
// ContextAssembler
// ---------------------------------------------------------------------------

export interface ContextAssemblerDeps {
  repos: Repos;
  tokenCounter: TokenCounter;
  /** 世界书扫描源的最近可见消息条数（§5.2 ②），默认 8 */
  scanSourceDepth?: number;
  /** 输出契约文本（§5.7 ①），默认 DEFAULT_OUTPUT_CONTRACT；传 '' 关闭 */
  outputContract?: string;
  /** 无默认 persona 时 {{user}} 的兜底名（ST 惯例 'User'） */
  defaultUserName?: string;
  /** tokenizer 提示 */
  model?: string;
}

export interface ContextAssembler {
  assemble(req: GenerationRequest): Promise<ChatMessage[]>;
}

/** JSONB 载荷 → 注入文本：字符串直接用；对象取 description/text，否则序列化 */
export function textOfJson(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['description', 'text']) {
      if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string;
    }
    return JSON.stringify(value);
  }
  return null;
}

const joinParts = (parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n\n');

export function createContextAssembler(deps: ContextAssemblerDeps): ContextAssembler {
  const {
    repos,
    tokenCounter,
    scanSourceDepth = 8,
    outputContract = DEFAULT_OUTPUT_CONTRACT,
    defaultUserName = 'User',
    model,
  } = deps;

  async function assemble(req: GenerationRequest): Promise<ChatMessage[]> {
    const char = await repos.characters.get(req.speakerCharacterId);
    if (!char) throw new Error(`发言角色不存在：${req.speakerCharacterId}`);
    const session = await repos.sessions.get(req.sessionId);
    if (!session) throw new Error(`场次不存在：${req.sessionId}`);
    const troupe = await repos.troupes.get(session.troupeId);
    if (!troupe) throw new Error(`场次所属团队不存在：${session.troupeId}`);
    const world = await repos.worlds.get(troupe.worldId);
    if (!world) throw new Error(`团队所属世界书不存在：${troupe.worldId}`);
    const persona: Persona | null = troupe.defaultPersonaId
      ? await repos.personas.get(troupe.defaultPersonaId)
      : null;

    const macroCtx = { char: char.name, user: persona?.name ?? defaultUserName };
    const budget = allocateBudget(session.settings?.maxContext ?? DEFAULT_MAX_CONTEXT);
    const castIds = await repos.sessionCast.list(session.id);

    // ② 世界书扫描（三级 scope 合并 + castPublicScopes，§5.2 ②）
    //    本人：public + private；其他在场角色：仅 public（§2.2 LorebookEntry）
    const scopes: LorebookScope[] = [
      { ownerType: 'world', ownerId: world.id },
      { ownerType: 'session', ownerId: session.id },
      { ownerType: 'character', ownerId: char.id },
      ...castPublicScopes(castIds, char.id),
    ];
    const allEntries = await repos.lorebookEntries.listByScopes(scopes);
    const entries: LorebookEntry[] = allEntries.filter((e) => {
      if (e.ownerType !== 'character') return true;
      if (e.ownerId === char.id) return true; // 本人：public + private
      return e.visibility === 'public';
    });

    const scanSourceMessages = await repos.messages.visibleTo(session.id, char.id, {
      limit: scanSourceDepth,
    });
    const scan = scanLorebook({
      sources: [
        ...scanSourceMessages.map(messagePublicText),
        cardText(char.card),
        ...(req.directive ? [req.directive] : []),
      ],
      entries,
      budget: budget.lorebook,
      tokenCounter,
      model,
    });

    // ① 基调与世界观层 + before_char 条目
    const system1 = substituteMacros(
      joinParts([
        troupe.toneDirective,
        textOfJson(world.premise),
        textOfJson(session.scene),
        ...activatedContents(scan.beforeChar),
      ]),
      macroCtx,
    );

    // ③ 角色卡层（本人：含 secrets）+ after_char 条目 + ④ memory + 输出契约
    const charDef = renderCharacterCard(char, { includeSecrets: true });
    // ④ 长期记忆层（§5.2）：本角色 × 本团队摘要，预算内最近优先（core/memory）
    const memoryText = buildMemoryLayer({
      records: await repos.memories.list(char.id, troupe.id),
      budgetTokens: budget.memory,
      tokenCounter,
      model,
    }).text;
    const system2 = substituteMacros(
      joinParts([
        charDef,
        ...activatedContents(scan.afterChar),
        memoryText || null,
        outputContract || null,
      ]),
      macroCtx,
    );

    // ⑤ 对话历史层（消息级粗筛 + 段落级过滤，token 预算内尽量多带）
    const history = await repos.messages.visibleTo(session.id, char.id, {
      tokenBudget: budget.history,
      tokenCounter,
      model,
    });

    const names = await buildSenderNames(repos, history, char);
    const historyChats: ChatMessage[] = [];
    for (const m of history) {
      const chat = historyMessageToChat(m, char.id, names);
      if (chat) historyChats.push(chat);
    }
    injectAtDepth(historyChats, scan);

    // ⑥ 导演指令作为最后一条 user 消息
    const directiveChat: ChatMessage | null = req.directive
      ? { role: 'user', content: substituteMacros(wrapDirective(req.directive), macroCtx) }
      : null;

    return [
      ...(system1 ? [{ role: 'system', content: system1 } as ChatMessage] : []),
      { role: 'system', content: system2 },
      ...historyChats,
      ...(directiveChat ? [directiveChat] : []),
    ];
  }

  return { assemble };
}

/** 历史中出现的发送者名称表（角色 + 化身） */
async function buildSenderNames(
  repos: Repos,
  history: Message[],
  self: Character,
): Promise<SenderNames> {
  const characters = new Map<string, string>([[self.id, self.name]]);
  const personas = new Map<string, string>();
  for (const m of history) {
    if (!m.senderId) continue;
    if (m.senderType === 'character' && !characters.has(m.senderId)) {
      const c = await repos.characters.get(m.senderId);
      if (c) characters.set(c.id, c.name);
    } else if (m.senderType === 'player' && !personas.has(m.senderId)) {
      const p = await repos.personas.get(m.senderId);
      if (p) personas.set(p.id, p.name);
    }
  }
  return {
    character: (id) => characters.get(id),
    persona: (id) => personas.get(id),
  };
}

/**
 * at_depth 条目按深度插桩进历史（§5.2 ⑤）：depth 表示"距历史末尾的消息数"，
 * 插入位置 = length - depth（钳位到 0），以 system 角色注入。
 * 多条目按 depth 从深到浅依次插入，保证相对顺序稳定。
 * 注意：at_depth 条目内容不做宏替换（⑥ 宏替换只作用 system 层与 directive）。
 */
export function injectAtDepth(history: ChatMessage[], scan: LorebookScanResult): void {
  const sorted = [...scan.atDepth].sort(
    (a, b) => (b.entry.depth ?? 1) - (a.entry.depth ?? 1),
  );
  for (const { entry } of sorted) {
    const depth = entry.depth ?? 1;
    const index = Math.max(0, history.length - depth);
    history.splice(index, 0, { role: 'system', content: entry.content });
  }
}
