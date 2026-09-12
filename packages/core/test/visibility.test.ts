import { describe, expect, it } from 'vitest';
import {
  messagePublicText,
  publicText,
  renderedText,
  renderMessageForReader,
} from '../src/visibility/index';
import type { Message, MessageSegment } from '../src/types';

const segments: MessageSegment[] = [
  { kind: 'speech', text: '公开台词', visibility: 'public' },
  { kind: 'action', text: '公开动作', visibility: 'public' },
  { kind: 'thought', text: '内心独白', visibility: 'self_director' },
  { kind: 'action', text: '隐蔽动作', visibility: 'director' },
];

function msg(senderType: Message['senderType'], senderId: string | null): Message {
  return {
    id: 'm1',
    sessionId: 's1',
    seq: 1,
    senderType,
    senderId,
    content: segments,
    visibleTo: ['alice', 'bob'],
    createdAt: new Date(0),
  };
}

describe('段落级可见性矩阵（§2.3 第二级过滤）', () => {
  it('本人消息（character 且 senderId 为本人）：public + self_director', () => {
    const rendered = renderMessageForReader(msg('character', 'alice'), 'alice');
    expect(rendered.map((s) => s.text)).toEqual(['公开台词', '公开动作', '内心独白']);
  });

  it('他人消息：仅 public', () => {
    const rendered = renderMessageForReader(msg('character', 'alice'), 'bob');
    expect(rendered.map((s) => s.text)).toEqual(['公开台词', '公开动作']);
  });

  it('导演视图（reader = null）：全部段落', () => {
    const rendered = renderMessageForReader(msg('character', 'alice'), null);
    expect(rendered).toHaveLength(4);
  });

  it('director 可见性的段落即使在本人的消息里也不给角色看', () => {
    const own: Message = {
      ...msg('character', 'alice'),
      content: [{ kind: 'action', text: '导演暗线', visibility: 'director' }],
    };
    expect(renderMessageForReader(own, 'alice')).toHaveLength(0);
  });

  it('导演旁白 / 玩家化身消息对角色读者来说没有"本人"，仅 public', () => {
    for (const [type, id] of [
      ['director', null],
      ['player', 'persona-1'],
    ] as const) {
      const rendered = renderMessageForReader(msg(type, id), 'alice');
      expect(rendered.every((s) => s.visibility === 'public')).toBe(true);
    }
  });

  it('renderedText：无可见段落返回 null（整条对读者隐藏）', () => {
    const hidden: Message = {
      ...msg('character', 'alice'),
      content: [{ kind: 'thought', text: '只有心声', visibility: 'self_director' }],
    };
    expect(renderedText(hidden, 'bob')).toBeNull();
    expect(renderedText(hidden, 'alice')).toBe('只有心声');
  });
});

describe('publicText（§5.2 ② 世界书扫描源）', () => {
  it('只提取 public 段落文本', () => {
    expect(publicText(segments)).toBe('公开台词\n公开动作');
    expect(messagePublicText(msg('character', 'alice'))).toBe('公开台词\n公开动作');
  });
});
