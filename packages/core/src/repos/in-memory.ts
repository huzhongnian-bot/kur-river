// 内存仓储实现：core 单测不起数据库（§4.3），也可供 web 层测试复用。
// 语义与 db 实现对齐：visibleTo 过滤、limit/tokenBudget 二选一、
// confirm 取 seq（进程内串行，等价于 §5.6 事务串行化后的结果）。

// Node 19+ / 浏览器全局 crypto；保持 core 零框架依赖，不引 node:crypto 类型
declare const crypto: { randomUUID(): string };

import type { LlmConnection } from '@kur-river/llm';
import { renderedText } from '../visibility/index';
import type {
  AppSettings,
  Character,
  Draft,
  GenerationPreset,
  LorebookEntry,
  MemoryRecord,
  Message,
  Persona,
  Session,
  Troupe,
  World,
} from '../types';
import type {
  DraftRepo,
  LorebookEntryRepo,
  MemoryRepo,
  MessageRepo,
  NewCharacter,
  NewDraft,
  NewGenerationPreset,
  NewLlmConnection,
  NewLorebookEntry,
  NewMemory,
  NewMessage,
  NewPersona,
  NewSession,
  NewTroupe,
  NewWorld,
  Repos,
  VisibleMessagesQuery,
} from './index';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';

const now = () => new Date();

export function createInMemoryRepos(): Repos {
  const worlds = new Map<string, World>();
  const characters = new Map<string, Character>();
  const personas = new Map<string, Persona>();
  const troupes = new Map<string, Troupe>();
  const troupeMembers = new Map<string, string[]>(); // troupeId -> characterIds
  const sessions = new Map<string, Session>();
  const sessionCast = new Map<string, string[]>(); // sessionId -> characterIds
  const messages = new Map<string, Message>();
  const drafts = new Map<string, Draft>();
  const lorebookEntries = new Map<string, LorebookEntry>();
  const memories = new Map<string, MemoryRecord>();
  const llmConnections = new Map<string, LlmConnection>();
  const generationPresets = new Map<string, GenerationPreset>();
  const settings = new Map<string, AppSettings>(); // userId -> row

  function nextSeq(sessionId: string): number {
    let max = 0;
    for (const m of messages.values()) {
      if (m.sessionId === sessionId && m.seq > max) max = m.seq;
    }
    return max + 1;
  }

  const messageRepo: MessageRepo = {
    async get(id) {
      return messages.get(id) ?? null;
    },
    async visibleTo(sessionId, characterId, query: VisibleMessagesQuery) {
      const visible = [...messages.values()]
        .filter((m) => m.sessionId === sessionId && m.visibleTo.includes(characterId))
        .sort((a, b) => a.seq - b.seq);
      if ('limit' in query) return visible.slice(-query.limit);
      // tokenBudget：从最新向前累计段落渲染文本的 token，至少带一条
      const picked: Message[] = [];
      let used = 0;
      for (let i = visible.length - 1; i >= 0; i--) {
        const m = visible[i];
        const tokens = query.tokenCounter.countText(
          renderedText(m, characterId) ?? '',
          query.model,
        );
        if (picked.length > 0 && used + tokens > query.tokenBudget) break;
        picked.unshift(m);
        used += tokens;
      }
      return picked;
    },
    async listRecent(sessionId, limit) {
      return [...messages.values()]
        .filter((m) => m.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq)
        .slice(-limit);
    },
    async append(input: NewMessage) {
      const message: Message = {
        id: crypto.randomUUID(),
        sessionId: input.sessionId,
        seq: nextSeq(input.sessionId),
        senderType: input.senderType,
        senderId: input.senderId ?? null,
        content: input.content,
        visibleTo: [...input.visibleTo],
        createdAt: now(),
      };
      messages.set(message.id, message);
      return message;
    },
    async grantVisibility(sessionId, characterId, opts) {
      let count = 0;
      for (const m of messages.values()) {
        if (m.sessionId !== sessionId) continue;
        if (opts?.upToSeq !== undefined && m.seq > opts.upToSeq) continue;
        if (m.visibleTo.includes(characterId)) continue;
        m.visibleTo = [...m.visibleTo, characterId];
        count++;
      }
      return count;
    },
  };

  const draftRepo: DraftRepo = {
    async get(id) {
      return drafts.get(id) ?? null;
    },
    async listBySession(sessionId) {
      return [...drafts.values()]
        .filter((d) => d.sessionId === sessionId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async create(input: NewDraft) {
      const ts = now();
      const draft: Draft = {
        id: crypto.randomUUID(),
        sessionId: input.sessionId,
        characterId: input.characterId,
        directive: input.directive ?? null,
        triggerMessageId: input.triggerMessageId ?? null,
        content: input.content ?? null,
        status: 'queued',
        error: null,
        resolvedConnectionId: input.resolvedConnectionId ?? null,
        resolvedModel: input.resolvedModel ?? null,
        resolvedParams: input.resolvedParams ?? null,
        createdAt: ts,
        updatedAt: ts,
      };
      drafts.set(draft.id, draft);
      return draft;
    },
    async updateStatus(id, status, opts) {
      const draft = drafts.get(id);
      if (!draft) return null;
      draft.status = status;
      if (opts && 'error' in opts) draft.error = opts.error ?? null;
      draft.updatedAt = now();
      return draft;
    },
    async updateContent(id, content) {
      const draft = drafts.get(id);
      if (!draft) return null;
      draft.content = content;
      draft.updatedAt = now();
      return draft;
    },
    async confirm(id, final) {
      const draft = drafts.get(id);
      if (!draft) throw new Error(`草稿不存在：${id}`);
      const message = await messageRepo.append({
        sessionId: draft.sessionId,
        senderType: 'character',
        senderId: draft.characterId,
        content: final.content,
        visibleTo: final.visibleTo,
      });
      draft.status = 'confirmed';
      draft.content = final.content;
      draft.updatedAt = now();
      return { draft, message };
    },
  };

  const lorebookRepo: LorebookEntryRepo = {
    async get(id) {
      return lorebookEntries.get(id) ?? null;
    },
    async listByOwner(ownerType, ownerId) {
      return [...lorebookEntries.values()].filter(
        (e) => e.ownerType === ownerType && e.ownerId === ownerId,
      );
    },
    async listByScopes(scopes) {
      const wanted = new Set(scopes.map((s) => `${s.ownerType}:${s.ownerId}`));
      return [...lorebookEntries.values()].filter((e) =>
        wanted.has(`${e.ownerType}:${e.ownerId}`),
      );
    },
    async create(input: NewLorebookEntry) {
      const entry: LorebookEntry = {
        id: crypto.randomUUID(),
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        visibility: input.visibility ?? 'public',
        keys: [...input.keys],
        secondaryKeys: input.secondaryKeys ?? null,
        content: input.content,
        position: input.position,
        depth: input.depth ?? null,
        insertionOrder: input.insertionOrder ?? 0,
        scanDepth: input.scanDepth ?? null,
        tokenBudget: input.tokenBudget ?? null,
        enabled: input.enabled ?? true,
      };
      lorebookEntries.set(entry.id, entry);
      return entry;
    },
    async update(id, patch) {
      const entry = lorebookEntries.get(id);
      if (!entry) return null;
      Object.assign(entry, patch);
      return entry;
    },
    async remove(id) {
      return lorebookEntries.delete(id);
    },
    async disableBySession(sessionId) {
      let count = 0;
      for (const e of lorebookEntries.values()) {
        if (e.ownerType === 'session' && e.ownerId === sessionId && e.enabled) {
          e.enabled = false;
          count++;
        }
      }
      return count;
    },
  };

  const memoryRepo: MemoryRepo = {
    async list(characterId, troupeId) {
      return [...memories.values()]
        .filter((m) => m.characterId === characterId && m.troupeId === troupeId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async append(input: NewMemory) {
      const record: MemoryRecord = { id: crypto.randomUUID(), ...input, createdAt: now() };
      memories.set(record.id, record);
      return record;
    },
  };

  return {
    worlds: {
      async get(id) {
        return worlds.get(id) ?? null;
      },
      async list() {
        return [...worlds.values()];
      },
      async create(input: NewWorld) {
        const world: World = {
          id: crypto.randomUUID(),
          userId: input.userId ?? DEFAULT_USER_ID,
          title: input.title,
          premise: input.premise ?? null,
          createdAt: now(),
        };
        worlds.set(world.id, world);
        return world;
      },
      async update(id, patch) {
        const world = worlds.get(id);
        if (!world) return null;
        if (patch.title !== undefined) world.title = patch.title;
        if (patch.premise !== undefined) world.premise = patch.premise;
        return world;
      },
      async remove(id) {
        return worlds.delete(id);
      },
    },

    characters: {
      async get(id) {
        return characters.get(id) ?? null;
      },
      async listByWorld(worldId) {
        return [...characters.values()].filter((c) => c.worldId === worldId);
      },
      async create(input: NewCharacter) {
        const character: Character = {
          id: crypto.randomUUID(),
          worldId: input.worldId,
          name: input.name,
          avatarUrl: input.avatarUrl ?? null,
          card: input.card ?? null,
          secrets: input.secrets ?? null,
          talkativeness: input.talkativeness ?? 0.5,
          llmConnectionId: input.llmConnectionId ?? null,
          model: input.model ?? null,
          createdAt: now(),
        };
        characters.set(character.id, character);
        return character;
      },
      async update(id, patch) {
        const character = characters.get(id);
        if (!character) return null;
        Object.assign(character, patch);
        return character;
      },
      async remove(id) {
        return characters.delete(id);
      },
    },

    personas: {
      async get(id) {
        return personas.get(id) ?? null;
      },
      async listByWorld(worldId) {
        return [...personas.values()].filter((p) => p.worldId === worldId);
      },
      async create(input: NewPersona) {
        const persona: Persona = {
          id: crypto.randomUUID(),
          worldId: input.worldId,
          name: input.name,
          description: input.description ?? null,
          createdAt: now(),
        };
        personas.set(persona.id, persona);
        return persona;
      },
      async update(id, patch) {
        const persona = personas.get(id);
        if (!persona) return null;
        if (patch.name !== undefined) persona.name = patch.name;
        if (patch.description !== undefined) persona.description = patch.description;
        return persona;
      },
      async remove(id) {
        return personas.delete(id);
      },
    },

    troupes: {
      async get(id) {
        return troupes.get(id) ?? null;
      },
      async listByWorld(worldId) {
        return [...troupes.values()].filter((t) => t.worldId === worldId);
      },
      async create(input: NewTroupe) {
        const troupe: Troupe = {
          id: crypto.randomUUID(),
          worldId: input.worldId,
          name: input.name,
          outline: input.outline ?? null,
          toneDirective: input.toneDirective ?? null,
          defaultPersonaId: input.defaultPersonaId ?? null,
          llmConnectionId: input.llmConnectionId ?? null,
          model: input.model ?? null,
          presetId: input.presetId ?? null,
          createdAt: now(),
        };
        troupes.set(troupe.id, troupe);
        return troupe;
      },
      async update(id, patch) {
        const troupe = troupes.get(id);
        if (!troupe) return null;
        Object.assign(troupe, patch);
        return troupe;
      },
      async remove(id) {
        return troupes.delete(id);
      },
    },

    troupeMembers: {
      async list(troupeId) {
        return [...(troupeMembers.get(troupeId) ?? [])];
      },
      async add(troupeId, characterId) {
        const list = troupeMembers.get(troupeId) ?? [];
        if (!list.includes(characterId)) list.push(characterId);
        troupeMembers.set(troupeId, list);
      },
      async remove(troupeId, characterId) {
        const list = troupeMembers.get(troupeId) ?? [];
        const next = list.filter((id) => id !== characterId);
        troupeMembers.set(troupeId, next);
        return next.length !== list.length;
      },
    },

    sessions: {
      async get(id) {
        return sessions.get(id) ?? null;
      },
      async listByTroupe(troupeId) {
        return [...sessions.values()].filter((s) => s.troupeId === troupeId);
      },
      async create(input: NewSession) {
        const session: Session = {
          id: crypto.randomUUID(),
          troupeId: input.troupeId,
          title: input.title ?? null,
          scene: input.scene ?? null,
          status: input.status ?? 'active',
          settings: input.settings ?? null,
          createdAt: now(),
        };
        sessions.set(session.id, session);
        return session;
      },
      async update(id, patch) {
        const session = sessions.get(id);
        if (!session) return null;
        Object.assign(session, patch);
        return session;
      },
      async updateSettings(id, patch) {
        const session = sessions.get(id);
        if (!session) return null;
        session.settings = { ...(session.settings ?? {}), ...patch };
        return session;
      },
      async remove(id) {
        return sessions.delete(id);
      },
    },

    sessionCast: {
      async list(sessionId) {
        return [...(sessionCast.get(sessionId) ?? [])];
      },
      async add(sessionId, characterId) {
        const list = sessionCast.get(sessionId) ?? [];
        if (!list.includes(characterId)) list.push(characterId);
        sessionCast.set(sessionId, list);
      },
      async remove(sessionId, characterId) {
        const list = sessionCast.get(sessionId) ?? [];
        const next = list.filter((id) => id !== characterId);
        sessionCast.set(sessionId, next);
        return next.length !== list.length;
      },
    },

    messages: messageRepo,
    drafts: draftRepo,
    lorebookEntries: lorebookRepo,
    memories: memoryRepo,

    llmConnections: {
      async get(id) {
        return llmConnections.get(id) ?? null;
      },
      async list() {
        return [...llmConnections.values()];
      },
      async create(input: NewLlmConnection) {
        const conn: LlmConnection = {
          id: crypto.randomUUID(),
          name: input.name,
          providerType: input.providerType,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          defaultModel: input.defaultModel ?? undefined,
          enabled: input.enabled ?? true,
        };
        llmConnections.set(conn.id, conn);
        return conn;
      },
      async update(id, patch) {
        const conn = llmConnections.get(id);
        if (!conn) return null;
        const next: LlmConnection = {
          ...conn,
          ...patch,
          defaultModel:
            patch.defaultModel === null ? undefined : (patch.defaultModel ?? conn.defaultModel),
        };
        llmConnections.set(id, next);
        return next;
      },
      async remove(id) {
        return llmConnections.delete(id);
      },
    },

    generationPresets: {
      async get(id) {
        return generationPresets.get(id) ?? null;
      },
      async list() {
        return [...generationPresets.values()];
      },
      async create(input: NewGenerationPreset) {
        const preset: GenerationPreset = { id: crypto.randomUUID(), ...input };
        generationPresets.set(preset.id, preset);
        return preset;
      },
      async update(id, patch) {
        const preset = generationPresets.get(id);
        if (!preset) return null;
        Object.assign(preset, patch);
        return preset;
      },
      async remove(id) {
        return generationPresets.delete(id);
      },
    },

    settings: {
      async get(userId = DEFAULT_USER_ID) {
        return settings.get(userId) ?? null;
      },
      async upsert(patch, userId = DEFAULT_USER_ID) {
        const existing = settings.get(userId);
        if (existing) {
          Object.assign(existing, patch);
          return existing;
        }
        const row: AppSettings = {
          id: crypto.randomUUID(),
          userId,
          defaultConnectionId: patch.defaultConnectionId ?? null,
          defaultPresetId: patch.defaultPresetId ?? null,
          defaultModel: patch.defaultModel ?? null,
        };
        settings.set(userId, row);
        return row;
      },
    },
  };
}
