// 仓储集成测试（真实 Postgres，§9：重点覆盖 visibleTo 过滤与 confirm 取 seq）。
// 隔离策略：每个用例前 TRUNCATE 全部 14 张表（CASCADE），只清数据不动结构。
//
// 门控：仅当显式设置 DATABASE_URL_TEST 时运行（M1-P1 阶段 `pnpm test`
// 不起数据库，本文件全部用例跳过）。用法：
//   pnpm db:dev  # 一个终端
//   DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:54329/kur_river \
//     pnpm --filter @kur-river/db test

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { createHeuristicTokenCounter, type Repos } from '@kur-river/core';
import { createRepos } from '../src/repos/index';
import * as schema from '../src/schema';

const RUN_INTEGRATION = Boolean(process.env.DATABASE_URL_TEST);
const describeIntegration = describe.skipIf(!RUN_INTEGRATION);

const DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://postgres@localhost:5432/kurriver';

const client = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(client, { schema });
const repos: Repos = createRepos(db);
const counter = createHeuristicTokenCounter();

const ALL_TABLES = [
  'settings',
  'generation_presets',
  'llm_connections',
  'memories',
  'lorebook_entries',
  'drafts',
  'messages',
  'session_cast',
  'sessions',
  'troupe_members',
  'troupes',
  'personas',
  'characters',
  'worlds',
];

beforeEach(async () => {
  await client.unsafe(`TRUNCATE ${ALL_TABLES.join(', ')} CASCADE`);
}, 20000);

afterAll(async () => {
  await client.unsafe(`TRUNCATE ${ALL_TABLES.join(', ')} CASCADE`);
  await client.end();
}, 20000);

/** 一条世界→团队→双角色→场次→双人在场 的最小数据链 */
async function seedSession() {
  const world = await repos.worlds.create({ title: '集成测试世界' });
  const troupe = await repos.troupes.create({ worldId: world.id, name: '测试团' });
  const alice = await repos.characters.create({ worldId: world.id, name: 'Alice' });
  const bob = await repos.characters.create({ worldId: world.id, name: 'Bob' });
  await repos.troupeMembers.add(troupe.id, alice.id);
  await repos.troupeMembers.add(troupe.id, bob.id);
  const session = await repos.sessions.create({ troupeId: troupe.id });
  await repos.sessionCast.add(session.id, alice.id);
  await repos.sessionCast.add(session.id, bob.id);
  return { world, troupe, alice, bob, session };
}

describeIntegration('messages.visibleTo（§2.3 第一级粗筛：visible_to @> ARRAY[...]）', () => {
  it('按可见性过滤、按 seq 升序；limit 取最近 N 条', async () => {
    const { session, alice, bob } = await seedSession();
    // seq1：全员可见；seq2：仅 alice；seq3：仅 bob；seq4：全员可见
    await repos.messages.append({
      sessionId: session.id, senderType: 'director',
      content: [{ kind: 'action', text: '幕一', visibility: 'public' }],
      visibleTo: [alice.id, bob.id],
    });
    await repos.messages.append({
      sessionId: session.id, senderType: 'character', senderId: alice.id,
      content: [{ kind: 'speech', text: '只对 Alice', visibility: 'public' }],
      visibleTo: [alice.id],
    });
    await repos.messages.append({
      sessionId: session.id, senderType: 'character', senderId: bob.id,
      content: [{ kind: 'speech', text: '只对 Bob', visibility: 'public' }],
      visibleTo: [bob.id],
    });
    await repos.messages.append({
      sessionId: session.id, senderType: 'director',
      content: [{ kind: 'action', text: '幕四', visibility: 'public' }],
      visibleTo: [alice.id, bob.id],
    });

    const forAlice = await repos.messages.visibleTo(session.id, alice.id, { limit: 10 });
    expect(forAlice.map((m) => m.seq)).toEqual([1, 2, 4]);

    const forBob = await repos.messages.visibleTo(session.id, bob.id, { limit: 10 });
    expect(forBob.map((m) => m.seq)).toEqual([1, 3, 4]);

    // limit：最近 2 条且保持升序
    const recent = await repos.messages.visibleTo(session.id, alice.id, { limit: 2 });
    expect(recent.map((m) => m.seq)).toEqual([2, 4]);
  });

  it('tokenBudget：从最新向前累计，预算内尽量多带、至少一条', async () => {
    const { session, alice } = await seedSession();
    for (let i = 1; i <= 4; i++) {
      await repos.messages.append({
        sessionId: session.id, senderType: 'director',
        content: [{ kind: 'action', text: '一'.repeat(10) + `${i}`, visibility: 'public' }],
        visibleTo: [alice.id],
      });
    }
    // 每条约 11 token；预算 25 → 带最新两条
    const picked = await repos.messages.visibleTo(session.id, alice.id, {
      tokenBudget: 25,
      tokenCounter: counter,
    });
    expect(picked.map((m) => m.seq)).toEqual([3, 4]);
    // 预算 0 也至少带一条
    const one = await repos.messages.visibleTo(session.id, alice.id, {
      tokenBudget: 0,
      tokenCounter: counter,
    });
    expect(one.map((m) => m.seq)).toEqual([4]);
  });
});

describeIntegration('drafts.confirm（§5.6：事务内锁场次行取 max(seq)+1）', () => {
  it('串行 confirm 两个 ready 草稿 → seq 递增、draft 置 confirmed', async () => {
    const { session, alice } = await seedSession();
    const mkReadyDraft = async (text: string) => {
      const d = await repos.drafts.create({
        sessionId: session.id,
        characterId: alice.id,
        content: [{ kind: 'speech', text, visibility: 'public' }],
      });
      const ready = await repos.drafts.updateStatus(d.id, 'ready');
      if (!ready) throw new Error('updateStatus 失败');
      return ready;
    };

    const d1 = await mkReadyDraft('第一句');
    const d2 = await mkReadyDraft('第二句');

    const cast = await repos.sessionCast.list(session.id);
    const r1 = await repos.drafts.confirm(d1.id, {
      content: d1.content!,
      visibleTo: cast,
    });
    const r2 = await repos.drafts.confirm(d2.id, {
      content: d2.content!,
      visibleTo: cast,
    });

    expect(r1.message.seq).toBe(1);
    expect(r2.message.seq).toBe(2);
    expect(r1.draft.status).toBe('confirmed');
    expect(r2.draft.status).toBe('confirmed');
    expect(r1.message.senderType).toBe('character');
    expect(r1.message.senderId).toBe(alice.id);
    expect(r2.message.visibleTo).toEqual(expect.arrayContaining([alice.id]));
  });

  it('confirm 与 messages.append 共用同一 seq 序列（直接落盘路径，§2.2）', async () => {
    const { session, alice } = await seedSession();
    const draft = await repos.drafts.create({
      sessionId: session.id,
      characterId: alice.id,
      content: [{ kind: 'speech', text: '草稿句', visibility: 'public' }],
    });
    await repos.drafts.updateStatus(draft.id, 'ready');

    const direct = await repos.messages.append({
      sessionId: session.id, senderType: 'player', senderId: null,
      content: [{ kind: 'speech', text: '玩家直接发言', visibility: 'public' }],
      visibleTo: [alice.id],
    });
    const confirmed = await repos.drafts.confirm(draft.id, {
      content: draft.content!,
      visibleTo: [alice.id],
    });
    expect(direct.seq).toBe(1);
    expect(confirmed.message.seq).toBe(2);

    const all = await repos.messages.listRecent(session.id, 10);
    expect(all.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('confirm 不存在的草稿抛错且不产生消息', async () => {
    const { session } = await seedSession();
    await expect(
      repos.drafts.confirm('00000000-0000-0000-0000-000000000000', {
        content: [{ kind: 'speech', text: 'x', visibility: 'public' }],
        visibleTo: [],
      }),
    ).rejects.toThrow('草稿不存在');
    expect(await repos.messages.listRecent(session.id, 10)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describeIntegration('messages.grantVisibility（§2.2 补发可见性）', () => {
  it('晚加入角色授权后可见上场前消息；upToSeq 限范围；重复授权不重复', async () => {
    const { session, alice, bob } = await seedSession();
    const say = (text: string, visibleTo: string[]) =>
      repos.messages.append({
        sessionId: session.id, senderType: 'character', senderId: alice.id,
        content: [{ kind: 'speech', text, visibility: 'public' }],
        visibleTo,
      });
    await say('上场前其一', [alice.id]); // seq1
    await say('上场前其二', [alice.id]); // seq2
    await say('Bob 在场后', [alice.id, bob.id]); // seq3
    await say('仍只对 Alice', [alice.id]); // seq4

    // 授权前：Bob 只能看到 seq3（§2.2 可见性快照语义）
    const before = await repos.messages.visibleTo(session.id, bob.id, { limit: 10 });
    expect(before.map((m) => m.seq)).toEqual([3]);

    // 部分补发：只补到 seq2（含端点）
    expect(await repos.messages.grantVisibility(session.id, bob.id, { upToSeq: 2 })).toBe(2);
    const mid = await repos.messages.visibleTo(session.id, bob.id, { limit: 10 });
    expect(mid.map((m) => m.seq)).toEqual([1, 2, 3]);

    // 全额补发：seq4 也补上；再次授权返回 0 且 visible_to 数组不重复
    expect(await repos.messages.grantVisibility(session.id, bob.id)).toBe(1);
    expect(await repos.messages.grantVisibility(session.id, bob.id)).toBe(0);
    const after = await repos.messages.visibleTo(session.id, bob.id, { limit: 10 });
    expect(after.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    for (const m of after) {
      expect(m.visibleTo.filter((id) => id === bob.id)).toHaveLength(1);
    }
    // 已授权的 Alice 视角不受影响
    const aliceView = await repos.messages.visibleTo(session.id, alice.id, { limit: 10 });
    expect(aliceView.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });
});

describeIntegration('sessions.updateSettings（§5.4 依次反应批次状态通道）', () => {
  it('浅合并：分批 patch 不互相覆盖；null 清除键；不存在的场次返回 null', async () => {
    const { session } = await seedSession();
    await repos.sessions.updateSettings(session.id, { maxContext: 8192 });

    const withBatch = await repos.sessions.updateSettings(session.id, {
      reactionBatch: { queue: ['c1', 'c2'], currentIndex: 0, total: 2 },
    });
    expect(withBatch?.settings?.maxContext).toBe(8192); // 前次 patch 保留
    expect(withBatch?.settings?.reactionBatch).toEqual({
      queue: ['c1', 'c2'],
      currentIndex: 0,
      total: 2,
    });

    // 批次推进：覆盖 reactionBatch 键，maxContext 不动
    const advanced = await repos.sessions.updateSettings(session.id, {
      reactionBatch: { queue: ['c1', 'c2'], currentIndex: 1, total: 2 },
    });
    expect(advanced?.settings?.reactionBatch).toMatchObject({ currentIndex: 1 });
    expect(advanced?.settings?.maxContext).toBe(8192);

    // 批次结束：置 null 清除
    const cleared = await repos.sessions.updateSettings(session.id, { reactionBatch: null });
    expect(cleared?.settings?.reactionBatch).toBeNull();
    expect(cleared?.settings?.maxContext).toBe(8192);

    // 读回持久化结果（不依赖 returning）
    const reloaded = await repos.sessions.get(session.id);
    expect(reloaded?.settings?.maxContext).toBe(8192);

    expect(
      await repos.sessions.updateSettings('00000000-0000-0000-0000-000000000000', {
        maxContext: 1,
      }),
    ).toBeNull();
  });
});
