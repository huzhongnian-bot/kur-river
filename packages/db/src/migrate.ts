// 执行 drizzle 迁移：pnpm db:migrate（根目录转发至此）
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// 加载根目录 .env.local / .env，cwd 为本包目录
for (const name of ['.env.local', '.env']) {
  const envPath = path.resolve(process.cwd(), '../../', name);
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL 未设置：请在仓库根目录 cp .env.example .env.local 并填入连接串');
  }
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  const migrationsFolder = path.resolve(__dirname, '../migrations');
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  await client.end();
  console.log('[migrate] done');
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
