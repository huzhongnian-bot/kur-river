// DraftRepo 的 Drizzle 实现（§2.2 Draft、§5.6 确认事务）。

import { desc, eq } from 'drizzle-orm';

import type { Draft, DraftRepo, DraftStatus, NewDraft } from '@kur-river/core';
import type { Database } from '../client';
import { drafts, messages } from '../schema';
import { lockSessionInTx, nextSeqInTx, toMessage } from './messages';

export type { Tx } from './messages';

export function toDraft(row: typeof drafts.$inferSelect): Draft {
  return { ...row, status: row.status as DraftStatus };
}

export function createDraftRepo(db: Database): DraftRepo {
  return {
    async get(id) {
      const [row] = await db.select().from(drafts).where(eq(drafts.id, id));
      return row ? toDraft(row) : null;
    },

    async listBySession(sessionId) {
      const rows = await db
        .select()
        .from(drafts)
        .where(eq(drafts.sessionId, sessionId))
        .orderBy(desc(drafts.createdAt));
      return rows.map(toDraft);
    },

    async create(input: NewDraft) {
      const [row] = await db
        .insert(drafts)
        .values({
          sessionId: input.sessionId,
          characterId: input.characterId,
          directive: input.directive ?? null,
          triggerMessageId: input.triggerMessageId ?? null,
          content: input.content ?? null,
          status: 'queued',
          resolvedConnectionId: input.resolvedConnectionId ?? null,
          resolvedModel: input.resolvedModel ?? null,
          resolvedParams: input.resolvedParams ?? null,
        })
        .returning();
      return toDraft(row);
    },

    async updateStatus(id, status, opts) {
      const [row] = await db
        .update(drafts)
        .set({ status, ...(opts && 'error' in opts ? { error: opts.error } : {}) })
        .where(eq(drafts.id, id))
        .returning();
      return row ? toDraft(row) : null;
    },

    async updateContent(id, content) {
      const [row] = await db
        .update(drafts)
        .set({ content })
        .where(eq(drafts.id, id))
        .returning();
      return row ? toDraft(row) : null;
    },

    // §5.6 确认事务：锁 draft 行 → 锁场次行 → max(seq)+1 插 message →
    // draft 置 confirmed 并写回最终段落。UNIQUE(session_id,seq) 兜底。
    async confirm(id, final) {
      return db.transaction(async (tx) => {
        const [draft] = await tx
          .select()
          .from(drafts)
          .where(eq(drafts.id, id))
          .for('update');
        if (!draft) throw new Error(`草稿不存在：${id}`);

        await lockSessionInTx(tx, draft.sessionId);
        const seq = await nextSeqInTx(tx, draft.sessionId);

        const [messageRow] = await tx
          .insert(messages)
          .values({
            sessionId: draft.sessionId,
            seq,
            senderType: 'character',
            senderId: draft.characterId,
            content: final.content,
            visibleTo: final.visibleTo,
          })
          .returning();

        const [draftRow] = await tx
          .update(drafts)
          .set({ status: 'confirmed', content: final.content })
          .where(eq(drafts.id, id))
          .returning();

        return { draft: toDraft(draftRow), message: toMessage(messageRow) };
      });
    },
  };
}
