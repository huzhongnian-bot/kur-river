// Playwright 冒烟（M1 单人戏 UI 闭环）：全局基建。
// global-setup 启动：独立内嵌 Postgres（.pgdata-smoke，随机端口）→ migrate →
// mock OpenAI（随机端口，SSE 流式）→ next start（随机端口，APP_PASSWORD=smoke-pw）。
// 端口经 process.env 传给 worker（SMOKE_WEB_BASE / SMOKE_MOCK_BASE），
// 避免与并发改动/残留服务撞固定端口。global-teardown 全部停掉并删除数据目录。
// SKIP_BUILD=1 跳过 next build。
import { spawn, spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

// playwright 以配置文件所在目录为 cwd（仓库根）
const rootDir = process.cwd();
const webDir = path.join(rootDir, 'apps', 'web');
const dataDir = path.join(rootDir, '.pgdata-smoke');

// SMOKE_APP_PASSWORD='' 时关闭密码门（UI 冒烟规避 Chromium fetch 不自动带
// httpCredentials 导致的 RSC 导航失败；门本身由 m1-e2e 与 401 spec 验证）
export const APP_PASSWORD = process.env.SMOKE_APP_PASSWORD ?? 'smoke-pw';
export const MOCK_TEXT = '模拟生成文本：雪落无声。';

// setup/teardown 同进程（playwright runner），模块级句柄直接共享
let pg: EmbeddedPostgres | null = null;
let mockServer: http.Server | null = null;
let nextChild: ReturnType<typeof spawn> | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = (srv.address() as net.AddressInfo);
      srv.close(() => resolve(port));
    });
  });
}

function startMockOpenAI(port: number): Promise<void> {
  mockServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'mock-model', object: 'model' },
            { id: 'mock-model-2', object: 'model' },
          ],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunks = ['模拟', '生成', '文本', '：雪', '落无', '声。'];
        let i = 0;
        const timer = setInterval(() => {
          if (i < chunks.length) {
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`,
            );
            i += 1;
          } else {
            clearInterval(timer);
            res.write(
              `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } })}\n\n`,
            );
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }, 20);
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    mockServer!.once('error', reject);
    mockServer!.listen(port, '127.0.0.1', () => resolve());
  });
}

export async function startInfra(): Promise<void> {
  const pgPort = await freePort();
  const mockPort = await freePort();
  const webPort = await freePort();
  const databaseUrl = `postgresql://postgres:postgres@localhost:${pgPort}/kur_river_smoke`;
  process.env.SMOKE_WEB_BASE = `http://127.0.0.1:${webPort}`;
  process.env.SMOKE_MOCK_BASE = `http://127.0.0.1:${mockPort}/v1`;

  console.log(`[smoke setup] 启动内嵌 Postgres（.pgdata-smoke:${pgPort}）…`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: pgPort,
    persistent: true,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('kur_river_smoke');

  console.log('[smoke setup] 应用迁移…');
  {
    const r = spawnSync('pnpm', ['--filter', '@kur-river/db', 'migrate'], {
      shell: true,
      stdio: 'inherit',
      cwd: rootDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    if (r.status !== 0) throw new Error(`pnpm db migrate 失败（${r.status}）`);
  }

  if (process.env.SKIP_BUILD !== '1') {
    console.log('[smoke setup] 构建 apps/web（SKIP_BUILD=1 可跳过）…');
    const r = spawnSync('pnpm', ['--filter', '@kur-river/web', 'build'], {
      shell: true,
      stdio: 'inherit',
      cwd: rootDir,
    });
    if (r.status !== 0) throw new Error('next build 失败');
  }

  console.log(`[smoke setup] 启动 mock OpenAI（${mockPort}）与 next（${webPort}）…`);
  await startMockOpenAI(mockPort);
  const nextBin = path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  let childExit: number | null = null;
  // SMOKE_NEXT_MODE=dev 用 next dev（默认 next start 跑生产构建）
  const nextMode = process.env.SMOKE_NEXT_MODE === 'dev' ? 'dev' : 'start';
  nextChild = spawn(process.execPath, [nextBin, nextMode, '-p', String(webPort)], {
    cwd: webDir,
    env: { ...process.env, DATABASE_URL: databaseUrl, APP_PASSWORD },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  nextChild.on('exit', (code) => {
    childExit = code ?? -1;
  });

  // 就绪探测 + 早退监视：端口被外部服务占用时 next 会立即退出，在此暴露而不是误判就绪
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (childExit !== null) {
      throw new Error(`next start 提前退出（code ${childExit}）——端口 ${webPort} 可能被占用`);
    }
    try {
      const res = await fetch(`${process.env.SMOKE_WEB_BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* 尚未就绪 */
    }
    if (Date.now() > deadline) throw new Error('next start 就绪超时');
    await sleep(500);
  }
  console.log(`[smoke setup] 就绪：web=${process.env.SMOKE_WEB_BASE} mock=${process.env.SMOKE_MOCK_BASE}`);
}

export async function stopInfra(): Promise<void> {
  if (nextChild) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${nextChild.pid} /T /F`, { stdio: 'ignore' });
      } else {
        nextChild.kill('SIGTERM');
      }
    } catch {
      /* 已退出 */
    }
    nextChild = null;
  }
  if (mockServer) {
    await new Promise((r) => mockServer!.close(r));
    mockServer = null;
  }
  if (pg) {
    try {
      await pg.stop();
    } catch {
      /* 忽略 */
    }
    pg = null;
  }
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
  console.log('[smoke teardown] 清理完成。');
}
