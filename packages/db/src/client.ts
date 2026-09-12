// postgres.js + drizzle 连接工厂。连接串来自参数或 env DATABASE_URL。
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = ReturnType<typeof createDb>;

export function createDb(url?: string) {
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL 未设置：请在仓库根目录 cp .env.example .env.local 并填入连接串');
  }
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}

// Next dev 热重载下避免重复建连：缓存到 globalThis
const globalForDb = globalThis as unknown as { __kurRiverDb?: Database };

export function getDb(url?: string): Database {
  if (!globalForDb.__kurRiverDb) {
    globalForDb.__kurRiverDb = createDb(url);
  }
  return globalForDb.__kurRiverDb;
}
