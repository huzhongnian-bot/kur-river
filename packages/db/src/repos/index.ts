// 仓储装配入口（§4.3：core 定义接口，db 用 Drizzle 实现）。

import type { Repos } from '@kur-river/core';
import type { Database } from '../client';
import {
  createCharacterRepo,
  createGenerationPresetRepo,
  createLlmConnectionRepo,
  createLorebookEntryRepo,
  createMemoryRepo,
  createPersonaRepo,
  createSessionCastRepo,
  createSessionRepo,
  createSettingsRepo,
  createTroupeMemberRepo,
  createTroupeRepo,
  createWorldRepo,
} from './crud';
import { createDraftRepo } from './drafts';
import { createMessageRepo } from './messages';

export function createRepos(db: Database): Repos {
  return {
    worlds: createWorldRepo(db),
    characters: createCharacterRepo(db),
    personas: createPersonaRepo(db),
    troupes: createTroupeRepo(db),
    troupeMembers: createTroupeMemberRepo(db),
    sessions: createSessionRepo(db),
    sessionCast: createSessionCastRepo(db),
    messages: createMessageRepo(db),
    drafts: createDraftRepo(db),
    lorebookEntries: createLorebookEntryRepo(db),
    memories: createMemoryRepo(db),
    llmConnections: createLlmConnectionRepo(db),
    generationPresets: createGenerationPresetRepo(db),
    settings: createSettingsRepo(db),
  };
}
