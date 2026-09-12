// 领域共享类型（DESIGN §2.2、§6.1），供 @kur-river/db 与 apps/web 复用。
// 实体字段镜像 §6.1 schema（可空列为 null），JSONB 载荷除已定型者外保留 unknown。

import type { GenerationParams } from '@kur-river/llm';

/** 段落式消息结构：LLM 散文输出按 台词/动作/心声 切分（§2.2） */
export type SegmentKind = 'speech' | 'action' | 'thought';

/**
 * 段落级可见性（§2.2）：
 * - public：在场全员可见（台词、公开动作的默认值）
 * - self_director：仅本人 + 导演可见（内心独白的默认值）
 * - director：仅导演可见（隐蔽动作、幕后信息）
 */
export type SegmentVisibility = 'public' | 'self_director' | 'director';

export interface MessageSegment {
  kind: SegmentKind;
  text: string;
  visibility: SegmentVisibility;
}

/** 消息发送者类型（§2.2 Message） */
export type SenderType = 'director' | 'character' | 'player';

// ---------------------------------------------------------------------------
// 实体（镜像 §6.1 schema 行形状）
// ---------------------------------------------------------------------------

export interface World {
  id: string;
  userId: string;
  title: string;
  /** 世界观前提设定（JSONB，渲染时取文本，见 context/textOfJson） */
  premise: unknown;
  createdAt: Date;
}

export interface Character {
  id: string;
  worldId: string;
  name: string;
  avatarUrl: string | null;
  /** ST Character Card V2/V3 spec 原文（JSONB） */
  card: unknown;
  /** 私有设定，仅注入本人生成上下文（§2.2） */
  secrets: unknown;
  talkativeness: number;
  /** 角色级模型绑定（§5.5），空则向上回退 */
  llmConnectionId: string | null;
  model: string | null;
  createdAt: Date;
}

/** 导演化身：{{user}} 宏替换来源（§2.2 Persona） */
export interface Persona {
  id: string;
  worldId: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

export interface Troupe {
  id: string;
  worldId: string;
  name: string;
  outline: unknown;
  /** 团队基调指令，注入所有生成（§2.2） */
  toneDirective: string | null;
  defaultPersonaId: string | null;
  /** 团队级模型绑定（§5.5），空则回退全局默认 */
  llmConnectionId: string | null;
  model: string | null;
  presetId: string | null;
  createdAt: Date;
}

/** 依次反应批次状态（§5.4）：存 session.settings.reactionBatch（JSONB，免迁移） */
export interface ReactionBatch {
  /** 由哪条消息触发（GenerationRequest.triggerMessageId 的来源） */
  triggerMessageId?: string;
  /** 触发时的导演指令（批次内各角色生成共用） */
  directive?: string;
  /** 待反应角色队列（characterId[]，按在场列表顺序，plan 时已按 cap 截断） */
  queue: string[];
  /** 0-based：当前应生成/正在等确认的角色下标；上一草稿确认后才 +1（严格串行） */
  currentIndex: number;
  /** = queue.length（冗余存储便于 UI 直接展示进度） */
  total: number;
}

/** 场次级配置（§5.2、§5.4）：maxContext / 依次反应批上限等 */
export interface SessionSettings {
  maxContext?: number;
  reactionBatchLimit?: number;
  /** 进行中的依次反应批次（§5.4）；批次结束/取消时置 null 清除 */
  reactionBatch?: ReactionBatch | null;
  [key: string]: unknown;
}

export type SessionStatus = 'active' | 'archived';

export interface Session {
  id: string;
  troupeId: string;
  title: string | null;
  /** 场景设定（JSONB：地点、时间、氛围、在场道具等；渲染取 description/text） */
  scene: unknown;
  status: SessionStatus;
  settings: SessionSettings | null;
  createdAt: Date;
}

export interface Message {
  id: string;
  sessionId: string;
  /** 场次内严格递增（§5.6） */
  seq: number;
  senderType: SenderType;
  /** character 消息 = character id；player 消息 = persona id；director 可空 */
  senderId: string | null;
  /** 段落数组（§2.2） */
  content: MessageSegment[];
  /** 消息级粗筛快照（§2.3）：创建时按当时在场名单快照 */
  visibleTo: string[];
  createdAt: Date;
}

export type DraftStatus =
  | 'queued'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'confirmed'
  | 'discarded';

export interface Draft {
  id: string;
  sessionId: string;
  characterId: string;
  /** 导演指令（幕后调度元数据，不落盘为消息，§2.2） */
  directive: string | null;
  triggerMessageId: string | null;
  /** 与 message 同构的段落数组 */
  content: MessageSegment[] | null;
  status: DraftStatus;
  error: string | null;
  /** 本次生成实际使用的模型配置快照（§2.2） */
  resolvedConnectionId: string | null;
  resolvedModel: string | null;
  resolvedParams: GenerationParams | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 世界书条目 scope（§2.2 LorebookEntry） */
export type LorebookOwnerType = 'world' | 'character' | 'session';

/** character 级条目可见性：public 在场全员生效 / private 仅注入本人 */
export type LorebookVisibility = 'public' | 'private';

/** 注入位置（§5.3）：before/after 角色卡定义，或按深度插桩进历史 */
export type LorebookPosition = 'before_char' | 'after_char' | 'at_depth';

export interface LorebookEntry {
  id: string;
  ownerType: LorebookOwnerType;
  ownerId: string;
  visibility: LorebookVisibility;
  keys: string[];
  /** ST AND 逻辑：主副关键词需同时命中 */
  secondaryKeys: string[] | null;
  content: string;
  position: LorebookPosition;
  /** position = at_depth 时的插入深度（§5.2 ⑤） */
  depth: number | null;
  /** 数值小者优先进入预算（§5.3） */
  insertionOrder: number;
  scanDepth: number | null;
  tokenBudget: number | null;
  /** session 级条目在场次归档时批量置 false */
  enabled: boolean;
}

/** 记忆摘要记录的种类（§2.2 Memory）：session = 单场摘要；epoch = 摘要的摘要（读取优化） */
export type MemoryKind = 'session' | 'epoch';

/** 记忆摘要：每场一条追加（§2.2 Memory）；epoch 可由覆盖的 session 记录重建 */
export interface MemoryRecord {
  id: string;
  characterId: string;
  troupeId: string;
  sessionId: string;
  kind: MemoryKind;
  /** 仅 epoch：合并了多少条最旧的 session 摘要（读取时跳过前 N 条原始记录） */
  coversCount: number | null;
  summary: string;
  createdAt: Date;
}

/** 命名采样参数预设（§5.5） */
export interface GenerationPreset {
  id: string;
  name: string;
  params: GenerationParams;
}

/** 全局默认连接/模型/预设（§5.5 优先级链最底层） */
export interface AppSettings {
  id: string;
  userId: string;
  defaultConnectionId: string | null;
  defaultPresetId: string | null;
  defaultModel: string | null;
}
