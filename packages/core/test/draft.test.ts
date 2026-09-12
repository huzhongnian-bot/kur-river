import { describe, expect, it } from 'vitest';
import {
  assertDraftTransition,
  buildMessageFromDraft,
  canTransitionDraft,
  confirmDraft,
  DRAFT_TRANSITIONS,
  DraftTransitionError,
  regenerateDraft,
  transitionDraft,
} from '../src/draft/index';
import { createInMemoryRepos } from '../src/repos/in-memory';
import type { DraftStatus, MessageSegment } from '../src/types';

describe('draft 状态机：合法/非法迁移矩阵（§2.2）', () => {
  it('主路径 queued→generating→ready→confirmed', () => {
    for (const [from, to] of [
      ['queued', 'generating'],
      ['generating', 'ready'],
      ['ready', 'confirmed'],
    ] as const) {
      expect(canTransitionDraft(from, to)).toBe(true);
      expect(() => assertDraftTransition(from, to)).not.toThrow();
    }
  });

  it('discard 路径与失败路径：queued→discarded、generating→failed、ready→discarded', () => {
    expect(canTransitionDraft('queued', 'discarded')).toBe(true);
    expect(canTransitionDraft('generating', 'failed')).toBe(true);
    expect(canTransitionDraft('ready', 'discarded')).toBe(true);
  });

  it('终态无出边：failed/confirmed/discarded（regenerate 由新 draft 承载）', () => {
    for (const from of ['failed', 'confirmed', 'discarded'] as const) {
      expect(DRAFT_TRANSITIONS[from]).toEqual([]);
      expect(canTransitionDraft(from, 'generating')).toBe(false);
      expect(() => assertDraftTransition(from, 'generating')).toThrow(DraftTransitionError);
    }
  });

  it('跨级跳跃非法：queued→ready、generating→confirmed', () => {
    expect(canTransitionDraft('queued', 'ready')).toBe(false);
    expect(() => assertDraftTransition('generating', 'confirmed')).toThrow(
      '非法草稿状态迁移：generating → confirmed',
    );
  });
});

describe('buildMessageFromDraft（§2.2：段落数组 + 在场名单快照）', () => {
  const content: MessageSegment[] = [
    { kind: 'speech', text: '台词', visibility: 'public' },
  ];

  it('构造 senderType=character 的 NewMessage，visibleTo 为在场名单快照', () => {
    const msg = buildMessageFromDraft(
      { sessionId: 's1', characterId: 'alice', content },
      ['alice', 'bob'],
    );
    expect(msg).toEqual({
      sessionId: 's1',
      senderType: 'character',
      senderId: 'alice',
      content,
      visibleTo: ['alice', 'bob'],
    });
  });

  it('导演定密后的段落优先于草稿原段落（§5.7 ③）', () => {
    const edited: MessageSegment[] = [
      { kind: 'thought', text: '改后', visibility: 'self_director' },
    ];
    const msg = buildMessageFromDraft(
      { sessionId: 's1', characterId: 'alice', content },
      ['alice'],
      { content: edited },
    );
    expect(msg.content).toBe(edited);
  });

  it('无内容抛错', () => {
    expect(() =>
      buildMessageFromDraft({ sessionId: 's1', characterId: 'a', content: null }, ['a']),
    ).toThrow('没有可落盘的段落内容');
  });
});

describe('confirmDraft / transitionDraft / regenerateDraft 编排（内存仓储）', () => {
  async function seed() {
    const repos = createInMemoryRepos();
    const world = await repos.worlds.create({ title: 'w' });
    const troupe = await repos.troupes.create({ worldId: world.id, name: 't' });
    const char = await repos.characters.create({ worldId: world.id, name: 'Alice' });
    const session = await repos.sessions.create({ troupeId: troupe.id });
    await repos.sessionCast.add(session.id, char.id);
    return { repos, session, char };
  }

  it('confirm：ready 草稿落盘为 seq 递增的 message，draft 置 confirmed', async () => {
    const { repos, session, char } = await seed();
    const mk = async (text: string) => {
      const d = await repos.drafts.create({
        sessionId: session.id,
        characterId: char.id,
        content: [{ kind: 'speech', text, visibility: 'public' }],
      });
      await transitionDraft(repos, d.id, 'generating');
      await transitionDraft(repos, d.id, 'ready');
      return d.id;
    };
    const r1 = await confirmDraft(repos, await mk('第一句'));
    const r2 = await confirmDraft(repos, await mk('第二句'));
    expect(r1.message.seq).toBe(1);
    expect(r2.message.seq).toBe(2);
    expect(r1.draft.status).toBe('confirmed');
    expect(r2.message.visibleTo).toEqual([char.id]);
    expect(r2.message.senderType).toBe('character');
    expect(r2.message.senderId).toBe(char.id);
  });

  it('非 ready 态 confirm 抛 DraftTransitionError；failed 保留 error', async () => {
    const { repos, session, char } = await seed();
    const d = await repos.drafts.create({ sessionId: session.id, characterId: char.id });
    await expect(confirmDraft(repos, d.id)).rejects.toThrow(DraftTransitionError);
    await transitionDraft(repos, d.id, 'generating');
    const failed = await transitionDraft(repos, d.id, 'failed', { error: '上游 500' });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('上游 500');
    // failed 不能复活，regenerate 走新 draft
    await expect(transitionDraft(repos, d.id, 'generating')).rejects.toThrow(
      DraftTransitionError,
    );
  });

  it('regenerateDraft：沿用原快照、可改写，原 draft 不动', async () => {
    const { repos, session, char } = await seed();
    const d = await repos.drafts.create({
      sessionId: session.id,
      characterId: char.id,
      directive: '原指令',
      resolvedConnectionId: 'conn-1',
      resolvedModel: 'model-a',
      resolvedParams: { temperature: 0.7 },
    });
    const copy = await regenerateDraft(repos, d.id, { directive: '新指令' });
    expect(copy.id).not.toBe(d.id);
    expect(copy.status).toBe('queued');
    expect(copy.directive).toBe('新指令');
    expect(copy.resolvedConnectionId).toBe('conn-1');
    expect(copy.resolvedModel).toBe('model-a');
    expect(copy.resolvedParams).toEqual({ temperature: 0.7 });
    expect((await repos.drafts.get(d.id))?.status).toBe('queued');
  });
});
