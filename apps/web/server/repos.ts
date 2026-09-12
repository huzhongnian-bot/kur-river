// 仓储装配（DESIGN §4.3）：core 定义接口、@kur-river/db 实现。
// Next dev 热重载下避免重复装配：缓存到 globalThis（与 db/client.getDb 同一约定）。
import type { Repos } from '@kur-river/core';
import { createRepos, getDb } from '@kur-river/db';

const globalForRepos = globalThis as unknown as { __kurRiverRepos?: Repos };

export function getRepos(): Repos {
  if (!globalForRepos.__kurRiverRepos) {
    globalForRepos.__kurRiverRepos = createRepos(getDb());
  }
  return globalForRepos.__kurRiverRepos;
}
