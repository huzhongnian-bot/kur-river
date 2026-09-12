// 启动开发用内嵌 Postgres（embedded-postgres，真实 Postgres 二进制）
// - 数据目录 <repo>/.pgdata（persistent，重启不丢数据）
// - 端口 54329，前台运行打日志，Ctrl+C 停止
// - 根目录 .env 不存在 DATABASE_URL 时自动写入
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(rootDir, '.pgdata');
const envPath = path.join(rootDir, '.env');

const PORT = 54329;
const USER = 'postgres';
const PASSWORD = 'postgres';
const DATABASE = 'kur_river';
const DATABASE_URL = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}`;

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
});

console.log(`[dev-db] data dir: ${dataDir}`);
if (!existsSync(dataDir)) {
  console.log('[dev-db] first run: initialising cluster (may download Postgres binaries, please wait)...');
  await pg.initialise();
}

console.log('[dev-db] starting postgres...');
await pg.start();

try {
  await pg.createDatabase(DATABASE);
  console.log(`[dev-db] database "${DATABASE}" created`);
} catch {
  console.log(`[dev-db] database "${DATABASE}" already exists`);
}

// 写入根目录 .env（若尚未配置 DATABASE_URL）
const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
if (/^DATABASE_URL=/m.test(envText)) {
  console.log('[dev-db] .env already has DATABASE_URL, leaving it untouched');
} else {
  const line = `DATABASE_URL=${DATABASE_URL}\n`;
  writeFileSync(envPath, envText + (envText && !envText.endsWith('\n') ? '\n' : '') + line);
  console.log('[dev-db] wrote DATABASE_URL to .env');
}
console.log(`[dev-db] DATABASE_URL=${DATABASE_URL}`);
console.log('[dev-db] postgres is ready. Ctrl+C to stop.');

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\n[dev-db] stopping postgres...');
  try {
    await pg.stop();
    console.log('[dev-db] stopped.');
  } catch (err) {
    console.error('[dev-db] error while stopping:', err);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
