// 领域事件总线（DESIGN §4.4 扩展点 2）：极简类型化发射器。
// 异步生成、自动摘要、骰子判定、TTS 等后续功能以订阅者身份挂接，不改内核。
// emit 同步派发；单个订阅者抛错不影响其他订阅者，全部派发完后
// 以 AggregateError 汇总上抛（进程内订阅者的错误不应被静默吞掉）。

import type { Draft, MemoryRecord, Message, Session } from '../types';

/** 领域事件 → 载荷类型（§4.4 列出的四类） */
export interface DomainEventMap {
  'draft.created': { draft: Draft };
  'message.confirmed': { draft: Draft; message: Message };
  'session.archived': { session: Session };
  'memory.summarized': { record: MemoryRecord };
}

export type DomainEventName = keyof DomainEventMap;

export type DomainEventHandler<K extends DomainEventName> = (
  payload: DomainEventMap[K],
) => void;

export interface DomainEventBus {
  /** 订阅事件；返回退订函数 */
  on<K extends DomainEventName>(name: K, handler: DomainEventHandler<K>): () => void;
  /** 同步派发：按注册顺序调用全部订阅者；错误汇总为 AggregateError 上抛 */
  emit<K extends DomainEventName>(name: K, payload: DomainEventMap[K]): void;
  /** 当前订阅者总数（测试/诊断用） */
  listenerCount(name?: DomainEventName): number;
}

export function createEventBus(): DomainEventBus {
  // 以 DomainEventName 联合类型擦除存储；注册/派发两侧由泛型保证类型对齐
  const handlers = new Map<DomainEventName, Set<(payload: never) => void>>();

  return {
    on(name, handler) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(handler as (payload: never) => void);
      return () => {
        set.delete(handler as (payload: never) => void);
      };
    },
    emit(name, payload) {
      const set = handlers.get(name);
      if (!set) return;
      const errors: unknown[] = [];
      for (const handler of [...set]) {
        try {
          handler(payload as never);
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, `事件 ${name} 的 ${errors.length} 个订阅者抛错`);
      }
    },
    listenerCount(name) {
      if (name !== undefined) return handlers.get(name)?.size ?? 0;
      let total = 0;
      for (const set of handlers.values()) total += set.size;
      return total;
    },
  };
}
