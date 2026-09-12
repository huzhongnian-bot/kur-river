import { describe, expect, it } from 'vitest';
import {
  allocateBudget,
  castPublicScopes,
  createContextAssembler,
  DEFAULT_BUDGET_RATIOS,
  DEFAULT_MAX_CONTEXT,
  DEFAULT_OUTPUT_CONTRACT,
  historyMessageToChat,
  injectAtDepth,
  type SenderNames,
} from '../src/context/index';
import { scanLorebook } from '../src/lorebook/index';
import { createInMemoryRepos } from '../src/repos/in-memory';
import type { Repos } from '../src/repos/index';
import { createHeuristicTokenCounter } from '../src/token-counter';
import type { Message, MessageSegment } from '../src/types';

const counter = createHeuristicTokenCounter();

describe('allocateBudget（§5.2：system 30% / history 50% / 输出保留 20%）', () => {
  it('默认 32768 按比例分配，三区之和 == maxContext', () => {
    const b = allocateBudget();
    expect(b.maxContext).toBe(DEFAULT_MAX_CONTEXT);
    expect(b.system).toBe(Math.floor(32768 * 0.3));
    expect(b.history).toBe(Math.floor(32768 * 0.5));
    expect(b.outputReserve).toBe(32768 - b.system - b.history);
    expect(b.outputReserve).toBeGreaterThanOrEqual(Math.floor(32768 * 0.2));
    expect(b.system + b.history + b.outputReserve).toBe(32768);
    expect(b.lorebook).toBe(Math.floor(b.system / 2));
  });

  it('小 maxContext 不产生负数', () => {
    const b = allocateBudget(3);
    expect(b.system + b.history + b.outputReserve).toBe(3);
    expect(b.lorebook).toBeGreaterThanOrEqual(0);
    expect(allocateBudget(0).maxContext).toBe(0);
  });

  it('自定义比例生效', () => {
    const b = allocateBudget(1000, { system: 0.5, history: 0.3, output: 0.2 } as typeof DEFAULT_BUDGET_RATIOS);
    expect(b.system).toBe(500);
    expect(b.history).toBe(300);
    expect(b.outputReserve).toBe(200);
  });
});

// ---------------------------------------------------------------------------

function msg(partial: Partial<Message> & Pick<Message, 'seq' | 'senderType'>): Message {
  return {
    id: `m${partial.seq}`,
    sessionId: 's1',
    senderId: null,
    content: [{ kind: 'speech', text: `文本${partial.seq}`, visibility: 'public' }],
    visibleTo: ['alice', 'bob'],
    createdAt: new Date(0),
    ...partial,
  };
}

const names: SenderNames = {
  character: (id) => ({ alice: 'Alice', bob: 'Bob' })[id],
  persona: (id) => ({ p1: '导演化身' })[id],
};

describe('role 映射（§5.2.1：以发言者为第一人称）', () => {
  it('发言角色自己的历史消息 → assistant，不加名字前缀', () => {
    const chat = historyMessageToChat(msg({ seq: 1, senderType: 'character', senderId: 'alice' }), 'alice', names);
    expect(chat).toEqual({ role: 'assistant', content: '文本1' });
  });

  it('其他角色 → user + "名字: " 前缀', () => {
    const chat = historyMessageToChat(msg({ seq: 2, senderType: 'character', senderId: 'bob' }), 'alice', names);
    expect(chat).toEqual({ role: 'user', content: 'Bob: 文本2' });
  });

  it('导演旁白 → user + "旁白: " 前缀；玩家化身 → user + 化身名前缀', () => {
    expect(historyMessageToChat(msg({ seq: 3, senderType: 'director' }), 'alice', names))
      .toEqual({ role: 'user', content: '旁白: 文本3' });
    expect(historyMessageToChat(msg({ seq: 4, senderType: 'player', senderId: 'p1' }), 'alice', names))
      .toEqual({ role: 'user', content: '导演化身: 文本4' });
  });

  it('段落渲染在映射前完成：他人消息只带 public 段落；全被过滤则返回 null', () => {
    const content: MessageSegment[] = [
      { kind: 'speech', text: '公开', visibility: 'public' },
      { kind: 'thought', text: '心声', visibility: 'self_director' },
    ];
    const m = msg({ seq: 5, senderType: 'character', senderId: 'bob', content });
    expect(historyMessageToChat(m, 'alice', names)?.content).toBe('Bob: 公开');
    expect(historyMessageToChat(m, 'bob', names)?.content).toBe('公开\n心声');

    const hidden = msg({
      seq: 6,
      senderType: 'character',
      senderId: 'bob',
      content: [{ kind: 'thought', text: '只有心声', visibility: 'self_director' }],
    });
    expect(historyMessageToChat(hidden, 'alice', names)).toBeNull();
  });
});

describe('injectAtDepth（§5.2 ⑤：at_depth 按深度插桩）', () => {
  it('depth 为距历史末尾的消息数，插入为 system；深者先插保证顺序稳定', () => {
    const history = [
      { role: 'user', content: 'h1' },
      { role: 'assistant', content: 'h2' },
      { role: 'user', content: 'h3' },
    ] as const;
    const mutable = history.map((h) => ({ ...h })) as { role: 'user' | 'assistant' | 'system'; content: string }[];
    const scan = scanLorebook({
      sources: ['x'],
      entries: [
        {
          id: 'd1', ownerType: 'world', ownerId: 'w', visibility: 'public',
          keys: ['x'], secondaryKeys: null, content: '深度1', position: 'at_depth',
          depth: 1, insertionOrder: 0, scanDepth: null, tokenBudget: null, enabled: true,
        },
        {
          id: 'd3', ownerType: 'world', ownerId: 'w', visibility: 'public',
          keys: ['x'], secondaryKeys: null, content: '深度3', position: 'at_depth',
          depth: 3, insertionOrder: 0, scanDepth: null, tokenBudget: null, enabled: true,
        },
      ],
      budget: 100,
      tokenCounter: counter,
    });
    injectAtDepth(mutable, scan);
    expect(mutable.map((m) => m.content)).toEqual(['深度3', 'h1', 'h2', '深度1', 'h3']);
    expect(mutable[0].role).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// assemble 端到端（内存仓储，不起库）
// ---------------------------------------------------------------------------

async function seed(): Promise<{ repos: Repos; sessionId: string; charId: string }> {
  const repos = createInMemoryRepos();
  const world = await repos.worlds.create({
    title: '边境',
    premise: '这是一个 {{user}} 与 {{char}} 冒险的世界。',
  });
  const persona = await repos.personas.create({ worldId: world.id, name: '导演' });
  const troupe = await repos.troupes.create({
    worldId: world.id,
    name: '一团',
    toneDirective: '本团走悬疑风',
    defaultPersonaId: persona.id,
  });
  const char = await repos.characters.create({
    worldId: world.id,
    name: 'Alice',
    card: { data: { name: 'Alice', description: '银发剑士', first_mes: 'hi' } },
    secrets: '左臂有龙形刺青',
  });
  await repos.troupeMembers.add(troupe.id, char.id);
  const session = await repos.sessions.create({
    troupeId: troupe.id,
    scene: { description: '雨夜，要塞城墙上' },
  });
  await repos.sessionCast.add(session.id, char.id);
  return { repos, sessionId: session.id, charId: char.id };
}

describe('ContextAssembler.assemble（§5.2 端到端，内存仓储）', () => {
  it('六步组装：基调/世界书/卡+secrets/历史/directive；宏只作用 system 与 directive', async () => {
    const { repos, sessionId, charId } = await seed();

    // 世界书条目：世界级 before_char 命中"龙"
    await repos.lorebookEntries.create({
      ownerType: 'world',
      ownerId: (await repos.worlds.list())[0].id,
      keys: ['龙'],
      content: '龙是濒危物种，{{char}} 对此知情。',
      position: 'before_char',
    });
    // 本人 private 条目经卡文本（"银发剑士"）命中
    await repos.lorebookEntries.create({
      ownerType: 'character',
      ownerId: charId,
      visibility: 'private',
      keys: ['剑士'],
      content: '刺青是龙族印记。',
      position: 'after_char',
    });

    // 历史：一条本人消息 + 一条导演旁白；本人消息里带 self_director 段落
    const cast = [charId];
    await repos.messages.append({
      sessionId,
      senderType: 'character',
      senderId: charId,
      content: [
        { kind: 'speech', text: '"城墙上有龙。"', visibility: 'public' },
        { kind: 'thought', text: '(我的刺青在发烫)', visibility: 'self_director' },
      ],
      visibleTo: cast,
    });
    await repos.messages.append({
      sessionId,
      senderType: 'director',
      content: [{ kind: 'action', text: '雷声滚过。', visibility: 'public' }],
      visibleTo: cast,
    });

    const assembler = createContextAssembler({ repos, tokenCounter: counter });
    const chats = await assembler.assemble({
      sessionId,
      speakerCharacterId: charId,
      directive: '让 {{char}} 注意到 {{user}} 的暗示',
    });

    // 结构：system1 / system2 / 历史×2 / directive
    expect(chats[0].role).toBe('system');
    expect(chats[0].content).toContain('本团走悬疑风');
    expect(chats[0].content).toContain('雨夜，要塞城墙上');
    expect(chats[0].content).toContain('龙是濒危物种'); // before_char 命中（扫描源含历史"龙"）
    expect(chats[0].content).toContain('Alice 对此知情'); // system 层宏替换
    expect(chats[0].content).toContain('Alice 冒险的世界'); // premise 宏替换

    expect(chats[1].role).toBe('system');
    expect(chats[1].content).toContain('银发剑士');
    expect(chats[1].content).toContain('左臂有龙形刺青'); // secrets 注入本人上下文
    expect(chats[1].content).toContain('刺青是龙族印记'); // 本人 private 条目
    expect(chats[1].content).toContain(DEFAULT_OUTPUT_CONTRACT);

    // 历史 role 映射：本人 → assistant（含 self_director），旁白 → user 带前缀
    expect(chats[2]).toEqual({
      role: 'assistant',
      content: '"城墙上有龙。"\n(我的刺青在发烫)',
    });
    expect(chats[3]).toEqual({ role: 'user', content: '旁白: 雷声滚过。' });

    // directive 收尾且宏替换
    expect(chats[4]).toEqual({
      role: 'user',
      content: '[导演指令] 让 Alice 注意到 导演 的暗示',
    });
  });

  it('无 directive 时不追加 user 收尾消息', async () => {
    const { repos, sessionId, charId } = await seed();
    const assembler = createContextAssembler({ repos, tokenCounter: counter });
    const chats = await assembler.assemble({ sessionId, speakerCharacterId: charId });
    expect(chats.every((c) => c.role !== 'user')).toBe(true);
    expect(chats).toHaveLength(2); // system1 + system2
  });

  it('角色/场次不存在时抛错', async () => {
    const { repos, sessionId, charId } = await seed();
    const assembler = createContextAssembler({ repos, tokenCounter: counter });
    await expect(
      assembler.assemble({ sessionId, speakerCharacterId: 'nope' }),
    ).rejects.toThrow('发言角色不存在');
    await expect(
      assembler.assemble({ sessionId: 'nope', speakerCharacterId: charId }),
    ).rejects.toThrow('场次不存在');
  });

  it('session.settings.maxContext 缺省 32768；历史按 tokenBudget 截断', async () => {
    const { repos, sessionId, charId } = await seed();
    await repos.sessions.update(sessionId, { settings: { maxContext: 100 } });
    // history 预算 = floor(100*0.5)=50 token；每条消息 ~20 CJK 字
    for (let i = 1; i <= 5; i++) {
      await repos.messages.append({
        sessionId,
        senderType: 'director',
        content: [{ kind: 'action', text: `第${'一'.repeat(20)}幕${i}`, visibility: 'public' }],
        visibleTo: [charId],
      });
    }
    const assembler = createContextAssembler({ repos, tokenCounter: counter });
    const chats = await assembler.assemble({ sessionId, speakerCharacterId: charId });
    const historyChats = chats.filter((c) => c.role === 'user');
    expect(historyChats.length).toBeLessThan(5);
    expect(historyChats.length).toBeGreaterThan(0);
    // 最新的消息优先保留
    expect(historyChats.at(-1)?.content).toContain('幕5');
  });
});

// ---------------------------------------------------------------------------
// castPublicScopes（§5.2 ② / §2.2：其他在场角色 public 条目对所有人扫描生效）
// ---------------------------------------------------------------------------

describe('castPublicScopes（§5.2 ② scope 形状）', () => {
  it('返回除本人外的在场角色 character scope；单角色在场时为空', () => {
    expect(castPublicScopes(['a', 'b', 'c'], 'a')).toEqual([
      { ownerType: 'character', ownerId: 'b' },
      { ownerType: 'character', ownerId: 'c' },
    ]);
    expect(castPublicScopes(['a'], 'a')).toEqual([]);
    expect(castPublicScopes([], 'a')).toEqual([]);
  });
});

describe('assemble 世界书扫描的 castPublicScopes 语义（§2.2）', () => {
  it('其他在场角色 public 生效 / private 不生效；本人 public+private 两档均生效', async () => {
    const { repos, sessionId, charId } = await seed();
    const worldId = (await repos.worlds.list())[0].id;
    const bob = await repos.characters.create({ worldId, name: 'Bob' });
    await repos.sessionCast.add(sessionId, bob.id);

    // 关键词"暗号"由 directive 命中扫描源
    await repos.lorebookEntries.create({
      ownerType: 'character', ownerId: bob.id, visibility: 'public',
      keys: ['暗号'], content: 'Bob 的公开设定：左撇子。', position: 'after_char',
    });
    await repos.lorebookEntries.create({
      ownerType: 'character', ownerId: bob.id, visibility: 'private',
      keys: ['暗号'], content: 'Bob 的私密设定：其实是卧底。', position: 'after_char',
    });
    await repos.lorebookEntries.create({
      ownerType: 'character', ownerId: charId, visibility: 'public',
      keys: ['暗号'], content: 'Alice 的公开设定：银发。', position: 'after_char',
    });
    await repos.lorebookEntries.create({
      ownerType: 'character', ownerId: charId, visibility: 'private',
      keys: ['暗号'], content: 'Alice 的私密设定：怕雷。', position: 'after_char',
    });

    const assembler = createContextAssembler({ repos, tokenCounter: counter });
    const chats = await assembler.assemble({
      sessionId, speakerCharacterId: charId, directive: '对暗号',
    });
    const system2 = chats[1].content;
    expect(system2).toContain('Bob 的公开设定'); // 其他在场角色 public 生效
    expect(system2).not.toContain('卧底'); // 其他在场角色 private 不生效
    expect(system2).toContain('Alice 的公开设定'); // 本人 public 生效
    expect(system2).toContain('Alice 的私密设定'); // 本人 private 生效
  });
});
