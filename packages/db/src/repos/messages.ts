// MessageRepo 的 Drizzle 实现（§2.3 第一级粗筛走 SQL，§5.6 seq 事务约定）。

import { and, desc, eq, gt, lte, sql } from 'drizzle-orm';

import type { MessageRepo, NewMessage, VisibleMessagesQuery } from '@kur-river/core';
import { renderedText, type Message, type SenderType } from '@kur-river/core';
import type { Database } from '../client';
import { messages, sessions } from '../schema';

/** tokenBudget 模式下向前回看的最深消息数（防全表扫描的安全阀） */
const TOKEN_SCAN_CAP = 200;

/** 与 Database 事务回调完全一致的 tx 类型（避免手写泛型参数漂移） */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** §5.6：锁场次行串行化 seq 分配（confirm 与 append 共用的序列化点） */
export async function lockSessionInTx(tx: Tx, sessionId: string): Promise<void> {
  await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .for('update');
}

export function toMessage(row: typeof messages.$inferSelect): Message {
  return { ...row, senderType: row.senderType as SenderType };
}

/**
 * §5.6：事务内取 max(seq)+1；调用前必须先经 lockSessionInTx 锁场次行。
 * UNIQUE(session_id, seq) 仅作最后防线。
 */
export async function nextSeqInTx(tx: Tx, sessionId: string): Promise<number> {
  const rows = await tx.execute<{ next: number }>(
    sql`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE session_id = ${sessionId}`,
  );
  return Number(rows[0].next);
}

export function createMessageRepo(db: Database): MessageRepo {
  return {
    async get(id) {
      const [row] = await db.select().from(messages).where(eq(messages.id, id));
      return row ? toMessage(row) : null;
    },

    async visibleTo(sessionId, characterId, query: VisibleMessagesQuery) {
      // §2.3 第一级粗筛：visible_to @> ARRAY[character_id]
      const cond = and(
        eq(messages.sessionId, sessionId),
        sql`${messages.visibleTo} @> ARRAY[${characterId}]::uuid[]`,
      );
      if ('limit' in query) {
        const rows = await db
          .select()
          .from(messages)
          .where(cond)
          .orderBy(desc(messages.seq))
          .limit(query.limit);
        return rows.reverse().map(toMessage);
      }
      // tokenBudget：取最近一批后从最新向前累计段落渲染文本的 token，至少带一条
      const rows = await db
        .select()
        .from(messages)
        .where(cond)
        .orderBy(desc(messages.seq))
        .limit(TOKEN_SCAN_CAP);
      const picked: Message[] = [];
      let used = 0;
      for (const row of rows) {
        const message = toMessage(row);
        const tokens = query.tokenCounter.countText(
          renderedText(message, characterId) ?? '',
          query.model,
        );
        if (picked.length > 0 && used + tokens > query.tokenBudget) break;
        picked.unshift(message);
        used += tokens;
      }
      return picked;
    },

    async listRecent(sessionId, limit) {
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(desc(messages.seq))
        .limit(limit);
      return rows.reverse().map(toMessage);
    },

    async append(input: NewMessage) {
      return db.transaction(async (tx) => {
        await lockSessionInTx(tx, input.sessionId);
        const seq = await nextSeqInTx(tx, input.sessionId);
        const [row] = await tx
          .insert(messages)
          .values({
            sessionId: input.sessionId,
            seq,
            senderType: input.senderType,
            senderId: input.senderId ?? null,
            content: input.content,
            visibleTo: input.visibleTo,
          })
          .returning();
        return toMessage(row);
      });
    },

    // §2.2 补发可见性：一条 UPDATE 完成；NOT @> 条件保证数组不重复
    async grantVisibility(sessionId, characterId, opts) {
      const rows = await db
        .update(messages)
        .set({
          visibleTo: sql`array_append(${messages.visibleTo}, ${characterId}::uuid)`,
        })
        .where(
          and(
            eq(messages.sessionId, sessionId),
            sql`NOT (${messages.visibleTo} @> ARRAY[${characterId}]::uuid[])`,
            ...(opts?.upToSeq !== undefined ? [lte(messages.seq, opts.upToSeq)] : []),
          ),
        )
        .returning({ id: messages.id });
      return rows.length;
    },

    // §7.1 M3 消息编辑：整体替换段落；visibleTo 快照不变
    async update(id, patch) {
      const [row] = await db
        .update(messages)
        .set({ content: patch.content })
        .where(eq(messages.id, id))
        .returning();
      return row ? toMessage(row) : null;
    },

    // §7.1 M3 截断重演：删除 seq 之后的全部消息
    async truncateAfter(sessionId, seq) {
      const rows = await db
        .delete(messages)
        .where(and(eq(messages.sessionId, sessionId), gt(messages.seq, seq)))
        .returning({ id: messages.id });
      return rows.length;
    },
  };
}
