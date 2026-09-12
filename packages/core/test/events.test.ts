import { describe, expect, it } from 'vitest';
import { createEventBus } from '../src/events/index';
import type { Draft } from '../src/types';

const draft = { id: 'd1' } as Draft;

describe('领域事件总线（§4.4：on/emit，类型化载荷）', () => {
  it('订阅者按注册顺序收到载荷；支持四类领域事件', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.on('draft.created', (p) => seen.push(`a:${p.draft.id}`));
    bus.on('draft.created', (p) => seen.push(`b:${p.draft.id}`));
    bus.emit('draft.created', { draft });
    expect(seen).toEqual(['a:d1', 'b:d1']);
    expect(bus.listenerCount('draft.created')).toBe(2);
  });

  it('退订函数生效；未订阅的事件 emit 为空操作', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const off = bus.on('message.confirmed', () => seen.push('x'));
    off();
    bus.emit('message.confirmed', {
      draft,
      message: { id: 'm1' } as never,
    });
    expect(seen).toEqual([]);
    expect(bus.listenerCount()).toBe(0);
  });

  it('单个订阅者抛错不影响其他订阅者，错误汇总上抛', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.on('session.archived', () => {
      throw new Error('boom');
    });
    bus.on('session.archived', () => seen.push('ok'));
    expect(() => bus.emit('session.archived', { session: { id: 's1' } as never })).toThrow(
      'boom',
    );
    expect(seen).toEqual(['ok']);
  });

  it('多个订阅者抛错时聚合为 AggregateError', () => {
    const bus = createEventBus();
    bus.on('memory.summarized', () => {
      throw new Error('e1');
    });
    bus.on('memory.summarized', () => {
      throw new Error('e2');
    });
    try {
      bus.emit('memory.summarized', { record: { id: 'r1' } as never });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toHaveLength(2);
    }
  });
});
