// 事件订阅者注册（DESIGN §4.4）：进程内挂接，幂等（globalThis 防 dev 热重载重复挂接）。
// session.archived → 对该场每个在场角色生成记忆摘要（§2.2 Memory）。
import { getEventBus } from './events';
import { summarizeArchivedSession } from './memory';
import { getRepos } from './repos';

const globalForSubscribers = globalThis as unknown as { __kurRiverSubscribed?: boolean };

/** 在使用事件的入口（archive 路由等）顶部调用；重复调用为 no-op */
export function ensureSubscribers(): void {
  if (globalForSubscribers.__kurRiverSubscribed) return;
  globalForSubscribers.__kurRiverSubscribed = true;
  getEventBus().on('session.archived', ({ session }) => {
    summarizeArchivedSession(getRepos(), session.id, session.troupeId);
  });
}
