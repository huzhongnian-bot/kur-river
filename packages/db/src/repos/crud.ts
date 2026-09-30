// 其余表的 CRUD 仓储（M1 所需读写）：worlds / characters / personas /
// troupes / troupe_members / sessions / session_cast / lorebook_entries /
// memories / llm_connections / generation_presets / settings。

import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import type {
  AppSettings,
  Character,
  CharacterRepo,
  GenerationPreset,
  GenerationPresetRepo,
  LorebookEntry,
  LorebookEntryRepo,
  LorebookOwnerType,
  LorebookPosition,
  LorebookScope,
  LorebookVisibility,
  LlmConnectionRepo,
  MemoryRecord,
  MemoryRepo,
  NewCharacter,
  NewGenerationPreset,
  NewLlmConnection,
  NewLorebookEntry,
  NewMemory,
  NewPersona,
  NewSession,
  NewTroupe,
  NewWorld,
  Persona,
  PersonaRepo,
  Session,
  SessionCastRepo,
  SessionRepo,
  SessionStatus,
  SettingsRepo,
  Troupe,
  TroupeMemberRepo,
  TroupeRepo,
  World,
  WorldRepo,
} from '@kur-river/core';
import type { LlmConnection } from '@kur-river/core';
import type { Database } from '../client';
import {
  characters,
  DEFAULT_USER_ID,
  generationPresets,
  llmConnections,
  lorebookEntries,
  memories,
  personas,
  sessionCast,
  sessions,
  settings,
  troupeMembers,
  troupes,
  worlds,
} from '../schema';

const toWorld = (row: typeof worlds.$inferSelect): World => row;
const toCharacter = (row: typeof characters.$inferSelect): Character => row;
const toPersona = (row: typeof personas.$inferSelect): Persona => row;
const toTroupe = (row: typeof troupes.$inferSelect): Troupe => row;
const toSession = (row: typeof sessions.$inferSelect): Session => ({
  ...row,
  status: row.status as SessionStatus,
});
const toLorebookEntry = (row: typeof lorebookEntries.$inferSelect): LorebookEntry => ({
  ...row,
  ownerType: row.ownerType as LorebookOwnerType,
  visibility: row.visibility as LorebookVisibility,
  position: row.position as LorebookPosition,
});
const toMemory = (row: typeof memories.$inferSelect): MemoryRecord => ({
  ...row,
  kind: row.kind as MemoryRecord['kind'],
});
const toLlmConnection = (row: typeof llmConnections.$inferSelect): LlmConnection => ({
  id: row.id,
  name: row.name,
  providerType: row.providerType,
  baseUrl: row.baseUrl,
  apiKey: row.apiKey,
  defaultModel: row.defaultModel ?? undefined,
  enabled: row.enabled,
});
const toPreset = (row: typeof generationPresets.$inferSelect): GenerationPreset => row;

export function createWorldRepo(db: Database): WorldRepo {
  return {
    async get(id) {
      const [row] = await db.select().from(worlds).where(eq(worlds.id, id));
      return row ? toWorld(row) : null;
    },
    async list() {
      const rows = await db.select().from(worlds).orderBy(asc(worlds.createdAt));
      return rows.map(toWorld);
    },
    async create(input: NewWorld) {
      const [row] = await db
        .insert(worlds)
        .values({
          title: input.title,
          premise: input.premise ?? null,
          ...(input.userId ? { userId: input.userId } : {}),
        })
        .returning();
      return toWorld(row);
    },
    async update(id, patch) {
      const [row] = await db.update(worlds).set(patch).where(eq(worlds.id, id)).returning();
      return row ? toWorld(row) : null;
    },
    async remove(id) {
      const rows = await db.delete(worlds).where(eq(worlds.id, id)).returning({ id: worlds.id });
      return rows.length > 0;
    },
  };
}

export function createCharacterRepo(db: Database): CharacterRepo {
  return {
    async get(id) {
      const [row] = await db.select().from(characters).where(eq(characters.id, id));
      return row ? toCharacter(row) : null;
    },
    async listByWorld(worldId) {
      const rows = await db
        .select()
        .from(characters)
        .where(eq(characters.worldId, worldId))
        .orderBy(asc(characters.createdAt));
      return rows.map(toCharacter);
    },
    async create(input: NewCharacter) {
      const [row] = await db
        .insert(characters)
        .values({
          worldId: input.worldId,
          name: input.name,
          avatarUrl: input.avatarUrl ?? null,
          card: input.card ?? null,
          secrets: input.secrets ?? null,
          ...(input.talkativeness !== undefined ? { talkativeness: input.talkativeness } : {}),
          llmConnectionId: input.llmConnectionId ?? null,
          model: input.model ?? null,
        })
        .returning();
      return toCharacter(row);
    },
    async update(id, patch) {
      const [row] = await db
        .update(characters)
        .set(patch)
        .where(eq(characters.id, id))
        .returning();
      return row ? toCharacter(row) : null;
    },
    async remove(id) {
      const rows = await db.delete(characters).where(eq(characters.id, id)).returning({ id: characters.id });
      return rows.length > 0;
    },
  };
}

export function createPersonaRepo(db: Database): PersonaRepo {
  return {
    async get(id) {
      const [row] = await db.select().from(personas).where(eq(personas.id, id));
      return row ? toPersona(row) : null;
    },
    async listByWorld(worldId) {
      const rows = await db
        .select()
        .from(personas)
        .where(eq(personas.worldId, worldId))
        .orderBy(asc(personas.createdAt));
      return rows.map(toPersona);
    },
    async create(input: NewPersona) {
      const [row] = await db.insert(personas).values({
        worldId: input.worldId,
        name: input.name,
        description: input.description ?? null,
      }).returning();
      return toPersona(row);
    },
    async update(id, patch) {
      const [row] = await db.update(personas).set(patch).where(eq(personas.id, id)).returning();
      return row ? toPersona(row) : null;
    },
    async remove(id) {
      const rows = await db.delete(personas).where(eq(personas.id, id)).returning({ id: personas.id });
      return rows.length > 0;
    },
  };
}

export function createTroupeRepo(db: Database): TroupeRepo {
  return {
    async get(id) {
      const [row] = await db.select().from(troupes).where(eq(troupes.id, id));
      return row ? toTroupe(row) : null;
    },
    async listByWorld(worldId) {
      const rows = await db
        .select()
        .from(troupes)
        .where(eq(troupes.worldId, worldId))
        .orderBy(asc(troupes.createdAt));
      return rows.map(toTroupe);
    },
    async create(input: NewTroupe) {
      const [row] = await db
        .insert(troupes)
        .values({
          worldId: input.worldId,
          name: input.name,
          outline: input.outline ?? null,
          toneDirective: input.toneDirective ?? null,
          skin: input.skin ?? 'modern',
          defaultPersonaId: input.defaultPersonaId ?? null,
          llmConnectionId: input.llmConnectionId ?? null,
          model: input.model ?? null,
          presetId: input.presetId ?? null,
        })
        .returning();
      return toTroupe(row);
    },
    async update(id, patch) {
      const [row] = await db.update(troupes).set(patch).where(eq(troupes.id, id)).returning();
      return row ? toTroupe(row) : null;
    },
    async remove(id) {
      const rows = await db.delete(troupes).where(eq(troupes.id, id)).returning({ id: troupes.id });
      return rows.length > 0;
    },
  };
}

export function createTroupeMemberRepo(db: Database): TroupeMemberRepo {
  return {
    async list(troupeId) {
      const rows = await db
        .select({ characterId: troupeMembers.characterId })
        .from(troupeMembers)
        .where(eq(troupeMembers.troupeId, troupeId))
        .orderBy(asc(troupeMembers.addedAt));
      return rows.map((r) => r.characterId);
    },
    async add(troupeId, characterId) {
      await db
        .insert(troupeMembers)
        .values({ troupeId, characterId })
        .onConflictDoNothing();
    },
    async remove(troupeId, characterId) {
      const rows = await db
        .delete(troupeMembers)
        .where(
          and(
            eq(troupeMembers.troupeId, troupeId),
            eq(troupeMembers.characterId, characterId),
          ),
        )
        .returning({ characterId: troupeMembers.characterId });
      return rows.length > 0;
    },
  };
}

export function createSessionRepo(db: Database): SessionRepo {
  return {
    async get(id) {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
      return row ? toSession(row) : null;
    },
    async listByTroupe(troupeId) {
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.troupeId, troupeId))
        .orderBy(asc(sessions.createdAt));
      return rows.map(toSession);
    },
    async create(input: NewSession) {
      const [row] = await db
        .insert(sessions)
        .values({
          troupeId: input.troupeId,
          title: input.title ?? null,
          scene: input.scene ?? null,
          status: input.status ?? 'active',
          settings: input.settings ?? null,
        })
        .returning();
      return toSession(row);
    },
    async update(id, patch) {
      const [row] = await db.update(sessions).set(patch).where(eq(sessions.id, id)).returning();
      return row ? toSession(row) : null;
    },
    // settings 浅合并（§5.4 批次状态通道）：jsonb || 顶层键覆盖，
    // 单条 UPDATE 原子完成；patch 值为 null 的键存为 JSON null（清除语义）
    async updateSettings(id, patch) {
      const [row] = await db
        .update(sessions)
        .set({
          settings: sql`COALESCE(${sessions.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        })
        .where(eq(sessions.id, id))
        .returning();
      return row ? toSession(row) : null;
    },
    async remove(id) {
      const rows = await db.delete(sessions).where(eq(sessions.id, id)).returning({ id: sessions.id });
      return rows.length > 0;
    },
  };
}

export function createSessionCastRepo(db: Database): SessionCastRepo {
  return {
    async list(sessionId) {
      const rows = await db
        .select({ characterId: sessionCast.characterId })
        .from(sessionCast)
        .where(eq(sessionCast.sessionId, sessionId));
      return rows.map((r) => r.characterId);
    },
    async add(sessionId, characterId) {
      await db.insert(sessionCast).values({ sessionId, characterId }).onConflictDoNothing();
    },
    async remove(sessionId, characterId) {
      const rows = await db
        .delete(sessionCast)
        .where(
          and(eq(sessionCast.sessionId, sessionId), eq(sessionCast.characterId, characterId)),
        )
        .returning({ characterId: sessionCast.characterId });
      return rows.length > 0;
    },
  };
}

export function createLorebookEntryRepo(db: Database): LorebookEntryRepo {
  return {
    async get(id) {
      const [row] = await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, id));
      return row ? toLorebookEntry(row) : null;
    },
    async listByOwner(ownerType, ownerId) {
      const rows = await db
        .select()
        .from(lorebookEntries)
        .where(
          and(eq(lorebookEntries.ownerType, ownerType), eq(lorebookEntries.ownerId, ownerId)),
        );
      return rows.map(toLorebookEntry);
    },
    async listByScopes(scopes: LorebookScope[]) {
      if (scopes.length === 0) return [];
      const cond = or(
        ...scopes.map((s) =>
          and(eq(lorebookEntries.ownerType, s.ownerType), eq(lorebookEntries.ownerId, s.ownerId)),
        ),
      );
      const rows = await db.select().from(lorebookEntries).where(cond);
      return rows.map(toLorebookEntry);
    },
    async create(input: NewLorebookEntry) {
      const [row] = await db
        .insert(lorebookEntries)
        .values({
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          visibility: input.visibility ?? 'public',
          keys: input.keys,
          secondaryKeys: input.secondaryKeys ?? null,
          content: input.content,
          position: input.position,
          depth: input.depth ?? null,
          insertionOrder: input.insertionOrder ?? 0,
          scanDepth: input.scanDepth ?? null,
          tokenBudget: input.tokenBudget ?? null,
          enabled: input.enabled ?? true,
        })
        .returning();
      return toLorebookEntry(row);
    },
    async update(id, patch) {
      const [row] = await db
        .update(lorebookEntries)
        .set(patch)
        .where(eq(lorebookEntries.id, id))
        .returning();
      return row ? toLorebookEntry(row) : null;
    },
    async remove(id) {
      const rows = await db
        .delete(lorebookEntries)
        .where(eq(lorebookEntries.id, id))
        .returning({ id: lorebookEntries.id });
      return rows.length > 0;
    },
    async disableBySession(sessionId) {
      const rows = await db
        .update(lorebookEntries)
        .set({ enabled: false })
        .where(
          and(
            eq(lorebookEntries.ownerType, 'session'),
            eq(lorebookEntries.ownerId, sessionId),
            eq(lorebookEntries.enabled, true),
          ),
        )
        .returning({ id: lorebookEntries.id });
      return rows.length;
    },
  };
}

export function createMemoryRepo(db: Database): MemoryRepo {
  return {
    // §2.2"按场次时间顺序"：按**场次的创建时间**排序（不是记录时间）——
    // 归档后修订重算会使记录 createdAt 跳到现在，但记忆仍属于旧场次（epoch 覆盖语义依赖场次时序）
    async list(characterId, troupeId) {
      const rows = await db
        .select({ m: memories })
        .from(memories)
        .leftJoin(sessions, eq(memories.sessionId, sessions.id))
        .where(and(eq(memories.characterId, characterId), eq(memories.troupeId, troupeId)))
        .orderBy(asc(sessions.createdAt), asc(memories.createdAt));
      return rows.map((r) => toMemory(r.m));
    },
    async append(input: NewMemory) {
      const [row] = await db
        .insert(memories)
        .values({
          characterId: input.characterId,
          troupeId: input.troupeId,
          sessionId: input.sessionId,
          kind: input.kind ?? 'session',
          coversCount: input.coversCount ?? null,
          summary: input.summary,
        })
        .returning();
      return toMemory(row);
    },
    async getEpoch(characterId, troupeId) {
      const [row] = await db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.characterId, characterId),
            eq(memories.troupeId, troupeId),
            eq(memories.kind, 'epoch'),
          ),
        )
        .limit(1);
      return row ? toMemory(row) : null;
    },
    // epoch 只是读取优化（§2.2 v0.4）：upsert 不触碰原始 session 记录
    async upsertEpoch(input) {
      const existing = await this.getEpoch(input.characterId, input.troupeId);
      if (existing) {
        const [row] = await db
          .update(memories)
          .set({ summary: input.summary, coversCount: input.coversCount, sessionId: input.sessionId })
          .where(eq(memories.id, existing.id))
          .returning();
        return toMemory(row);
      }
      const [row] = await db
        .insert(memories)
        .values({
          characterId: input.characterId,
          troupeId: input.troupeId,
          sessionId: input.sessionId,
          kind: 'epoch',
          coversCount: input.coversCount,
          summary: input.summary,
        })
        .returning();
      return toMemory(row);
    },
    // 已归档场次消息变更 → 作废该场全部摘要（§2.2 重算前置）
    async deleteBySession(sessionId) {
      const rows = await db
        .delete(memories)
        .where(eq(memories.sessionId, sessionId))
        .returning({ id: memories.id });
      return rows.length;
    },
  };
}

export function createLlmConnectionRepo(db: Database): LlmConnectionRepo {
  return {
    async get(id) {
      const [row] = await db.select().from(llmConnections).where(eq(llmConnections.id, id));
      return row ? toLlmConnection(row) : null;
    },
    async list() {
      const rows = await db.select().from(llmConnections).orderBy(asc(llmConnections.createdAt));
      return rows.map(toLlmConnection);
    },
    async create(input: NewLlmConnection) {
      const [row] = await db
        .insert(llmConnections)
        .values({
          name: input.name,
          providerType: input.providerType,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          defaultModel: input.defaultModel ?? null,
          enabled: input.enabled ?? true,
        })
        .returning();
      return toLlmConnection(row);
    },
    async update(id, patch) {
      const [row] = await db
        .update(llmConnections)
        .set(patch)
        .where(eq(llmConnections.id, id))
        .returning();
      return row ? toLlmConnection(row) : null;
    },
    async remove(id) {
      const rows = await db
        .delete(llmConnections)
        .where(eq(llmConnections.id, id))
        .returning({ id: llmConnections.id });
      return rows.length > 0;
    },
  };
}

export function createGenerationPresetRepo(db: Database): GenerationPresetRepo {
  return {
    async get(id) {
      const [row] = await db.select().from(generationPresets).where(eq(generationPresets.id, id));
      return row ? toPreset(row) : null;
    },
    async list() {
      const rows = await db.select().from(generationPresets);
      return rows.map(toPreset);
    },
    async create(input: NewGenerationPreset) {
      const [row] = await db.insert(generationPresets).values(input).returning();
      return toPreset(row);
    },
    async update(id, patch) {
      const [row] = await db
        .update(generationPresets)
        .set(patch)
        .where(eq(generationPresets.id, id))
        .returning();
      return row ? toPreset(row) : null;
    },
    async remove(id) {
      const rows = await db
        .delete(generationPresets)
        .where(eq(generationPresets.id, id))
        .returning({ id: generationPresets.id });
      return rows.length > 0;
    },
  };
}

export function createSettingsRepo(db: Database): SettingsRepo {
  return {
    async get(userId = DEFAULT_USER_ID) {
      const [row] = await db.select().from(settings).where(eq(settings.userId, userId));
      return row ?? null;
    },
    async upsert(patch, userId = DEFAULT_USER_ID) {
      const [existing] = await db.select().from(settings).where(eq(settings.userId, userId));
      if (existing) {
        const [row] = await db
          .update(settings)
          .set(patch)
          .where(eq(settings.id, existing.id))
          .returning();
        return row;
      }
      const [row] = await db
        .insert(settings)
        .values({
          userId,
          defaultConnectionId: patch.defaultConnectionId ?? null,
          defaultPresetId: patch.defaultPresetId ?? null,
          defaultModel: patch.defaultModel ?? null,
        })
        .returning();
      return row;
    },
  };
}
