// 领域事件总线实例（DESIGN §4.4 扩展点 2）：进程内单例。
// M1 尚无订阅者；confirm/创建草稿等关键节点先发事件，
// 后续功能（自动摘要、骰子、TTS、通知）以订阅者身份挂接，不改内核。
// Next dev 热重载下避免重复实例：缓存到 globalThis（与 server/repos 同一约定）。
import { createEventBus, type DomainEventBus } from '@kur-river/core';

const globalForEvents = globalThis as unknown as { __kurRiverEvents?: DomainEventBus };

export function getEventBus(): DomainEventBus {
  if (!globalForEvents.__kurRiverEvents) {
    globalForEvents.__kurRiverEvents = createEventBus();
  }
  return globalForEvents.__kurRiverEvents;
}
