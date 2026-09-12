// 数据层 schema（DESIGN §6.1）：PostgreSQL + JSONB，Drizzle 表达。
// 文档形数据（卡/条目/premise/outline/scene/段落式消息）全部 JSONB 承接，
// 关系主干（消息流/可见性/层级）走关系模型。
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { GenerationParams, MessageSegment, SessionSettings } from '@kur-river/core';

// 段落式消息结构类型来自领域内核（DESIGN §2.2），此处转发方便上层取用
export type { MessageSegment, SegmentKind, SegmentVisibility } from '@kur-river/core';

/** 单用户 MVP 的固定默认用户 id（DESIGN §6.1 注释：多用户化预留） */
export const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';

const defaultUserId = sql`'${sql.raw(DEFAULT_USER_ID)}'::uuid`;

const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const worlds = pgTable('worlds', {
  id: uuid('id').primaryKey().defaultRandom(),
  // 单用户 MVP 恒为默认用户，多用户化预留
  userId: uuid('user_id').notNull().default(defaultUserId),
  title: text('title').notNull(),
  premise: jsonb('premise'),
  createdAt: createdAt(),
});

export const characters = pgTable('characters', {
  id: uuid('id').primaryKey().defaultRandom(),
  worldId: uuid('world_id')
    .notNull()
    .references(() => worlds.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  // ST Character Card V2/V3 spec 原文
  card: jsonb('card'),
  // 私有设定，仅注入本人生成上下文（DESIGN §2.2）
  secrets: jsonb('secrets'),
  talkativeness: real('talkativeness').notNull().default(0.5),
  // 角色级模型绑定（§5.5 覆盖优先级链），空则向上回退
  llmConnectionId: uuid('llm_connection_id').references(() => llmConnections.id),
  model: text('model'),
  createdAt: createdAt(),
});

// 导演化身：导演以 player 身份发言时的"我"，{{user}} 宏替换来源
export const personas = pgTable('personas', {
  id: uuid('id').primaryKey().defaultRandom(),
  worldId: uuid('world_id')
    .notNull()
    .references(() => worlds.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: createdAt(),
});

export const troupes = pgTable('troupes', {
  id: uuid('id').primaryKey().defaultRandom(),
  worldId: uuid('world_id')
    .notNull()
    .references(() => worlds.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // 剧目大纲（结构化 JSON：幕次划分、剧情节点）
  outline: jsonb('outline'),
  // 团队基调指令，注入所有生成
  toneDirective: text('tone_directive'),
  defaultPersonaId: uuid('default_persona_id').references(() => personas.id),
  // 团队级模型绑定（§5.5），空则回退全局默认
  llmConnectionId: uuid('llm_connection_id').references(() => llmConnections.id),
  model: text('model'),
  presetId: uuid('preset_id').references(() => generationPresets.id),
  createdAt: createdAt(),
});

export const troupeMembers = pgTable(
  'troupe_members',
  {
    troupeId: uuid('troupe_id')
      .notNull()
      .references(() => troupes.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.troupeId, t.characterId] })],
);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  troupeId: uuid('troupe_id')
    .notNull()
    .references(() => troupes.id, { onDelete: 'cascade' }),
  title: text('title'),
  // 场景设定（地点、时间、氛围、在场道具等）
  scene: jsonb('scene'),
  // active / archived
  status: text('status').notNull().default('active'),
  // maxContext / 依次反应批上限等场次级配置（§5.2、§5.4）
  settings: jsonb('settings').$type<SessionSettings>(),
  createdAt: createdAt(),
});

export const sessionCast = pgTable(
  'session_cast',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.characterId] })],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // 场次内严格递增（§5.6：confirm 事务内串行化取 max(seq)+1，UNIQUE 作最后防线）
    seq: integer('seq').notNull(),
    // director / character / player
    senderType: text('sender_type').notNull(),
    // character 消息 = character id；player 消息 = persona id；director 可空
    senderId: uuid('sender_id'),
    // 段落数组 [{kind,text,visibility}]（§2.2）
    content: jsonb('content').$type<MessageSegment[]>().notNull(),
    // 消息级粗筛快照（§2.3）：创建时按在场名单快照
    visibleTo: uuid('visible_to').array().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('messages_session_id_seq_uniq').on(t.sessionId, t.seq),
    // 分页主路径
    index('messages_session_id_seq_idx').on(t.sessionId, t.seq),
    // 可见性过滤：visible_to @> ARRAY[:character_id]
    index('messages_visible_to_gin_idx').using('gin', t.visibleTo),
  ],
);

// 草稿：确认制的载体（§2.2 Draft，状态机 §5.6）
export const drafts = pgTable('drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  characterId: uuid('character_id')
    .notNull()
    .references(() => characters.id),
  directive: text('directive'),
  triggerMessageId: uuid('trigger_message_id').references(() => messages.id),
  // 与 message 同构的段落数组
  content: jsonb('content').$type<MessageSegment[]>(),
  // queued / generating / ready / failed / confirmed / discarded
  status: text('status').notNull().default('queued'),
  error: text('error'),
  // 本次生成实际使用的模型配置快照，支撑重抽 A/B 与追溯（§2.2）
  resolvedConnectionId: uuid('resolved_connection_id').references(() => llmConnections.id),
  resolvedModel: text('resolved_model'),
  resolvedParams: jsonb('resolved_params').$type<GenerationParams>(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// 世界书条目：三级 scope 通过 owner_type + owner_id 表达（§2.2 LorebookEntry）
export const lorebookEntries = pgTable(
  'lorebook_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // world / character / session
    ownerType: text('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    // character 级条目：public 在场全员生效 / private 仅注入本人
    visibility: text('visibility').notNull().default('public'),
    keys: text('keys').array().notNull(),
    // ST AND 逻辑：主副关键词需同时命中
    secondaryKeys: text('secondary_keys').array(),
    content: text('content').notNull(),
    // before_char / after_char / at_depth
    position: text('position').notNull(),
    // position = at_depth 时的插入深度（§5.2 ⑤）
    depth: integer('depth'),
    insertionOrder: integer('insertion_order').notNull().default(0),
    scanDepth: integer('scan_depth'),
    tokenBudget: integer('token_budget'),
    // session 级条目在场次归档时批量置 false
    enabled: boolean('enabled').notNull().default(true),
  },
  // scope 查询
  (t) => [index('lorebook_entries_owner_idx').on(t.ownerType, t.ownerId)],
);

// 记忆摘要：每场一条追加；聚合与滚动合并（epoch）见 §2.2 Memory
export const memories = pgTable('memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  characterId: uuid('character_id')
    .notNull()
    .references(() => characters.id, { onDelete: 'cascade' }),
  troupeId: uuid('troupe_id')
    .notNull()
    .references(() => troupes.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull(),
  createdAt: createdAt(),
});

// 一条命名连接 = 一个可用 API 来源（§5.5）
export const llmConnections = pgTable('llm_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // 决定用哪个 Adapter，如 'openai-compatible'
  providerType: text('provider_type').notNull(),
  baseUrl: text('base_url').notNull(),
  // 服务端保管；自部署 MVP 明文，多用户化时换加密存储
  apiKey: text('api_key').notNull(),
  defaultModel: text('default_model'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
});

// 命名采样参数预设（§5.5）
export const generationPresets = pgTable('generation_presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  params: jsonb('params').$type<GenerationParams>().notNull(),
});

// 全局默认连接/模型/预设（§5.5 优先级链最底层）
export const settings = pgTable('settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  // 同 worlds.user_id，单用户恒为默认
  userId: uuid('user_id').notNull().default(defaultUserId),
  defaultConnectionId: uuid('default_connection_id').references(() => llmConnections.id),
  defaultPresetId: uuid('default_preset_id').references(() => generationPresets.id),
  defaultModel: text('default_model'),
});
