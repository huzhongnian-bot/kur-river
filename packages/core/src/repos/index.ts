// 仓储接口（DESIGN §4.3）：core 定义、@kur-river/db 用 Drizzle 实现。
// core 单测用同目录 in-memory 实现，不起数据库。
//
// 形状要点：
// - messages.visibleTo：limit 与 tokenBudget 二选一（§5.2 ②扫描源用 limit，
//   ⑤历史层用 tokenBudget）；返回均按 seq 升序。
// - drafts.confirm：draft→message 的事务转换（§5.6），实现方必须在单事务内
//   锁场次行后取 max(seq)+1，UNIQUE(session_id,seq) 兜底。

import type { TokenCounter } from '@kur-river/llm';
import type {
  AppSettings,
  Character,
  Draft,
  DraftStatus,
  GenerationPreset,
  LorebookEntry,
  LorebookOwnerType,
  MemoryRecord,
  Message,
  MessageSegment,
  Persona,
  SenderType,
  Session,
  SessionSettings,
  Troupe,
  World,
} from '../types';

// ---------------------------------------------------------------------------
// 输入类型
// ---------------------------------------------------------------------------

export interface NewWorld {
  title: string;
  premise?: unknown;
  userId?: string;
}

export interface NewCharacter {
  worldId: string;
  name: string;
  avatarUrl?: string | null;
  card?: unknown;
  secrets?: unknown;
  talkativeness?: number;
  llmConnectionId?: string | null;
  model?: string | null;
}

export interface NewPersona {
  worldId: string;
  name: string;
  description?: string | null;
}

export interface NewTroupe {
  worldId: string;
  name: string;
  outline?: unknown;
  toneDirective?: string | null;
  defaultPersonaId?: string | null;
  llmConnectionId?: string | null;
  model?: string | null;
  presetId?: string | null;
}

export interface NewSession {
  troupeId: string;
  title?: string | null;
  scene?: unknown;
  status?: Session['status'];
  settings?: SessionSettings | null;
}

/** 直接落盘路径（§2.2）：落盘前宏替换、默认单 public 段落，由调用方保证 */
export interface NewMessage {
  sessionId: string;
  senderType: SenderType;
  senderId?: string | null;
  content: MessageSegment[];
  /** 可见性快照（§2.2）：创建时按当时在场名单 */
  visibleTo: string[];
}

export interface NewDraft {
  sessionId: string;
  characterId: string;
  directive?: string | null;
  triggerMessageId?: string | null;
  content?: MessageSegment[] | null;
  /** 模型配置快照（§2.2）：创建时由 resolveModel 结果写入 */
  resolvedConnectionId?: string | null;
  resolvedModel?: string | null;
  resolvedParams?: import('@kur-river/llm').GenerationParams | null;
}

export interface NewLorebookEntry {
  ownerType: LorebookOwnerType;
  ownerId: string;
  visibility?: 'public' | 'private';
  keys: string[];
  secondaryKeys?: string[] | null;
  content: string;
  position: LorebookEntry['position'];
  depth?: number | null;
  insertionOrder?: number;
  scanDepth?: number | null;
  tokenBudget?: number | null;
  enabled?: boolean;
}

export interface NewLlmConnection {
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string | null;
  enabled?: boolean;
}

export interface NewGenerationPreset {
  name: string;
  params: import('@kur-river/llm').GenerationParams;
}

export interface NewMemory {
  characterId: string;
  troupeId: string;
  sessionId: string;
  summary: string;
}

/** 世界书 scope 查询单位（§2.2 三级 scope） */
export interface LorebookScope {
  ownerType: LorebookOwnerType;
  ownerId: string;
}

// ---------------------------------------------------------------------------
// messages.visibleTo 查询：limit 或 tokenBudget 二选一（§5.2）
// ---------------------------------------------------------------------------

export type VisibleMessagesQuery =
  | { limit: number }
  | { tokenBudget: number; tokenCounter: TokenCounter; model?: string };

// ---------------------------------------------------------------------------
// 各表仓储
// ---------------------------------------------------------------------------

export interface WorldRepo {
  get(id: string): Promise<World | null>;
  list(): Promise<World[]>;
  create(input: NewWorld): Promise<World>;
  update(id: string, patch: Partial<NewWorld>): Promise<World | null>;
  remove(id: string): Promise<boolean>;
}

export interface CharacterRepo {
  get(id: string): Promise<Character | null>;
  listByWorld(worldId: string): Promise<Character[]>;
  create(input: NewCharacter): Promise<Character>;
  update(id: string, patch: Partial<NewCharacter>): Promise<Character | null>;
  remove(id: string): Promise<boolean>;
}

export interface PersonaRepo {
  get(id: string): Promise<Persona | null>;
  listByWorld(worldId: string): Promise<Persona[]>;
  create(input: NewPersona): Promise<Persona>;
  update(id: string, patch: Partial<NewPersona>): Promise<Persona | null>;
  remove(id: string): Promise<boolean>;
}

export interface TroupeRepo {
  get(id: string): Promise<Troupe | null>;
  listByWorld(worldId: string): Promise<Troupe[]>;
  create(input: NewTroupe): Promise<Troupe>;
  update(id: string, patch: Partial<NewTroupe>): Promise<Troupe | null>;
  remove(id: string): Promise<boolean>;
}

export interface TroupeMemberRepo {
  /** 返回 characterId 列表（按加入顺序） */
  list(troupeId: string): Promise<string[]>;
  add(troupeId: string, characterId: string): Promise<void>;
  remove(troupeId: string, characterId: string): Promise<boolean>;
}

export interface SessionRepo {
  get(id: string): Promise<Session | null>;
  listByTroupe(troupeId: string): Promise<Session[]>;
  create(input: NewSession): Promise<Session>;
  update(id: string, patch: Partial<NewSession>): Promise<Session | null>;
  remove(id: string): Promise<boolean>;
  /**
   * settings 浅合并通道（§5.4 依次反应批次状态的读写）：patch 的顶层键
   * 覆盖现有 settings（settings 为 null 时以 {} 为底）；值传 null 即把该键
   * 存为 JSON null（调用方以此清除 reactionBatch）。单条 UPDATE 原子完成。
   */
  updateSettings(id: string, patch: SessionSettings): Promise<Session | null>;
}

export interface SessionCastRepo {
  /** 在场名单（characterId 列表）；visibleTo 快照的来源（§2.2） */
  list(sessionId: string): Promise<string[]>;
  add(sessionId: string, characterId: string): Promise<void>;
  remove(sessionId: string, characterId: string): Promise<boolean>;
}

export interface MessageRepo {
  get(id: string): Promise<Message | null>;
  /**
   * 第一级粗筛（§2.3）：visible_to @> [characterId]，按 seq 升序返回。
   * limit 取最近 N 条；tokenBudget 从最新向前累计段落渲染文本的 token，
   * 预算耗尽即止（至少带一条）。
   */
  visibleTo(
    sessionId: string,
    characterId: string,
    query: VisibleMessagesQuery,
  ): Promise<Message[]>;
  /** 导演视图：最近 N 条（不分可见性），按 seq 升序 */
  listRecent(sessionId: string, limit: number): Promise<Message[]>;
  /** 直接落盘（§2.2）：与 confirm 同一约定，事务内锁场次行取 max(seq)+1（§5.6） */
  append(input: NewMessage): Promise<Message>;
  /**
   * 补发可见性（§2.2）：把 characterId 追加进该场次（可选 seq 上限，
   * 含端点）所有消息的 visibleTo，供晚加入角色补看上场前剧情。
   * 已可见的消息跳过（数组不重复）。返回实际授权的消息条数。
   */
  grantVisibility(
    sessionId: string,
    characterId: string,
    opts?: { upToSeq?: number },
  ): Promise<number>;
}

export interface DraftRepo {
  get(id: string): Promise<Draft | null>;
  listBySession(sessionId: string): Promise<Draft[]>;
  /** 创建 queued 态草稿（状态机入口，§2.2） */
  create(input: NewDraft): Promise<Draft>;
  /** 状态迁移落库；合法性校验在 core draft 状态机，本接口不重复校验 */
  updateStatus(id: string, status: DraftStatus, opts?: { error?: string | null }): Promise<Draft | null>;
  /** 导演定密：ready 态下编辑段落内容/可见性后再确认（§5.7 ③） */
  updateContent(id: string, content: MessageSegment[]): Promise<Draft | null>;
  /**
   * 确认事务（§5.6）：单事务内锁场次行 → max(seq)+1 插 message
   * （senderType=character、senderId=draft.characterId）→ draft 置 confirmed
   * 并写回最终段落。返回落盘后的 draft 与 message。
   */
  confirm(
    id: string,
    final: { content: MessageSegment[]; visibleTo: string[] },
  ): Promise<{ draft: Draft; message: Message }>;
}

export interface LorebookEntryRepo {
  get(id: string): Promise<LorebookEntry | null>;
  listByOwner(ownerType: LorebookOwnerType, ownerId: string): Promise<LorebookEntry[]>;
  /** 三级 scope 合并查询（§5.2 ②）；enabled/visibility 过滤由调用方处理 */
  listByScopes(scopes: LorebookScope[]): Promise<LorebookEntry[]>;
  create(input: NewLorebookEntry): Promise<LorebookEntry>;
  update(id: string, patch: Partial<NewLorebookEntry>): Promise<LorebookEntry | null>;
  remove(id: string): Promise<boolean>;
  /** 场次归档时批量失效 session 级条目（§2.2） */
  disableBySession(sessionId: string): Promise<number>;
}

export interface MemoryRepo {
  /** 本角色 × 本团队的全部摘要，按场次时间升序（§2.2 Memory；M3 才有数据） */
  list(characterId: string, troupeId: string): Promise<MemoryRecord[]>;
  append(input: NewMemory): Promise<MemoryRecord>;
}

export interface LlmConnectionRepo {
  get(id: string): Promise<import('@kur-river/llm').LlmConnection | null>;
  list(): Promise<import('@kur-river/llm').LlmConnection[]>;
  create(input: NewLlmConnection): Promise<import('@kur-river/llm').LlmConnection>;
  update(
    id: string,
    patch: Partial<NewLlmConnection>,
  ): Promise<import('@kur-river/llm').LlmConnection | null>;
  remove(id: string): Promise<boolean>;
}

export interface GenerationPresetRepo {
  get(id: string): Promise<GenerationPreset | null>;
  list(): Promise<GenerationPreset[]>;
  create(input: NewGenerationPreset): Promise<GenerationPreset>;
  update(id: string, patch: Partial<NewGenerationPreset>): Promise<GenerationPreset | null>;
  remove(id: string): Promise<boolean>;
}

export interface SettingsRepo {
  /** userId 缺省为单用户默认（§6.1）；无行时返回 null */
  get(userId?: string): Promise<AppSettings | null>;
  /** 无行则插入，有行则按 patch 更新 */
  upsert(
    patch: Partial<Pick<AppSettings, 'defaultConnectionId' | 'defaultPresetId' | 'defaultModel'>>,
    userId?: string,
  ): Promise<AppSettings>;
}

/** 装配根：db 包 createRepos(db) 与 core 内存实现共用的形状 */
export interface Repos {
  worlds: WorldRepo;
  characters: CharacterRepo;
  personas: PersonaRepo;
  troupes: TroupeRepo;
  troupeMembers: TroupeMemberRepo;
  sessions: SessionRepo;
  sessionCast: SessionCastRepo;
  messages: MessageRepo;
  drafts: DraftRepo;
  lorebookEntries: LorebookEntryRepo;
  memories: MemoryRepo;
  llmConnections: LlmConnectionRepo;
  generationPresets: GenerationPresetRepo;
  settings: SettingsRepo;
}
