// 事件订阅者注册（DESIGN §4.4）：进程内挂接，幂等（globalThis 防 dev 热重载重复挂接）。
// session.archived → 对该场每个在场角色生成记忆摘要（§2.2 Memory）。
// 另含启动愈合（M3 遗留）：进程重启时归档摘要可能因中途宕机缺失，
// 启动时扫一遍"已归档且在场角色缺摘要"的场次补算（幂等，成功=记录存在）。
import { getEventBus } from './events';
import { summarizeArchivedSession, summarizeSessionFor } from './memory';
import { getRepos } from './repos';

const globalForSubscribers = globalThis as unknown as {
  __kurRiverSubscribed?: boolean;
  __kurRiverBootHealed?: boolean;
};

/** 在使用事件的入口（archive 路由等）顶部调用；重复调用为 no-op */
export function ensureSubscribers(): void {
  if (globalForSubscribers.__kurRiverSubscribed) return;
  globalForSubscribers.__kurRiverSubscribed = true;
  getEventBus().on('session.archived', ({ session }) => {
    summarizeArchivedSession(getRepos(), session.id, session.troupeId);
  });
}

/** 启动愈合（instrumentation register 调用；进程内只跑一次） */
export async function healMissingSummariesOnBoot(): Promise<void> {
  if (globalForSubscribers.__kurRiverBootHealed) return;
  globalForSubscribers.__kurRiverBootHealed = true;
  ensureSubscribers();
  try {
    const repos = getRepos();
    const worlds = await repos.worlds.list();
    for (const world of worlds) {
      const troupes = await repos.troupes.listByWorld(world.id);
      for (const troupe of troupes) {
        const sessions = await repos.sessions.listByTroupe(troupe.id);
        for (const session of sessions) {
          if (session.status !== 'archived') continue;
          const castIds = await repos.sessionCast.list(session.id);
          for (const characterId of castIds) {
            const records = (await repos.memories.list(characterId, troupe.id)).filter(
              (r) => r.sessionId === session.id && r.kind === 'session',
            );
            if (records.length === 0) {
              console.log(
                `[memory] 启动愈合：补算 session ${session.id} / character ${characterId}`,
              );
              await summarizeSessionFor(repos, {
                sessionId: session.id,
                troupeId: troupe.id,
                characterId,
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[memory] 启动愈合异常（不影响服务）:', err);
  }
}
