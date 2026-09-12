import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'drizzle-kit';

// 开发便利：加载根目录 .env.local / .env，cwd 为本包目录
for (const name of ['.env.local', '.env']) {
  const envPath = path.resolve(process.cwd(), '../../', name);
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
