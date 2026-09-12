// M1 端到端验收：完整"单人戏"全流程（DESIGN §8 M1 验收：能完整演一场单人戏）。
// 不起 UI、不走真实 LLM：
//   - 内建 mock OpenAI 服务（node:http 随机端口，/models + 流式 chat/completions，
//     可注入"下一次返回 500"）
//   - 独立内嵌 Postgres（.pgdata-e2e，端口 54429，跑完停库删目录，不碰开发库）
//   - pnpm db:migrate 应用迁移 → next build（SKIP_BUILD=1 可跳过）→ next start
//   - 设 APP_PASSWORD：先断言一次 401，之后带 Basic 凭证跑完全流程
// 任一断言失败即非零退出；全绿输出 "M1 E2E OK"。

import { spawn, execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(rootDir, 'apps', 'web');
const e2eDataDir = path.join(rootDir, '.pgdata-e2e');

const PG_PORT = 54429;
const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'kur_river_e2e';
const DATABASE_URL = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DATABASE}`;
const APP_PASSWORD = 'e2e-pw';
const AUTH = `Basic ${Buffer.from(`director:${APP_PASSWORD}`).toString('base64')}`;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

let stepNo = 0;
function step(msg) {
  stepNo += 1;
  console.log(`\n[e2e ${String(stepNo).padStart(2, '0')}] ${msg}`);
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`\n[e2e] ✗ 断言失败：${msg}`);
    process.exitCode = 1;
    throw new Error(`断言失败：${msg}`);
  }
  console.log(`  ✓ ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true, stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`)),
    );
  });
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* 已退出 */
  }
}

// ---------------------------------------------------------------------------
// mock OpenAI 服务
// ---------------------------------------------------------------------------

const MOCK_TEXT = '模拟生成文本：雪落无声。';

function startMockOpenAI() {
  const state = { failNext: false, lastChatBody: null, chatCount: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
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
        state.lastChatBody = JSON.parse(raw);
        state.chatCount += 1;
        if (state.failNext) {
          state.failNext = false;
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: 'mock 注入的上游 500', type: 'server_error', code: 500 },
            }),
          );
          return;
        }
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, state, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

// ---------------------------------------------------------------------------
// API 驱动
// ---------------------------------------------------------------------------

let apiBase = '';

async function api(method, p, body, opts = {}) {
  const res = await fetch(`${apiBase}${p}`, {
    method,
    headers: {
      authorization: AUTH,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { __raw: text };
  }
  return { status: res.status, data };
}

async function apiOk(method, p, body, expect = [200, 201]) {
  const { status, data } = await api(method, p, body);
  assert(expect.includes(status), `${method} ${p} → ${status}（${JSON.stringify(data)?.slice(0, 300)}）`);
  return data;
}

/** 轮询草稿直到进入目标状态之一 */
async function pollDraft(id, until, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const draft = await apiOk('GET', `/api/drafts/${id}`);
    if (until.includes(draft.status)) return draft;
    if (Date.now() > deadline) {
      throw new Error(`草稿 ${id} 轮询超时（当前 ${draft.status}，期望 ${until.join('/')}）`);
    }
    await sleep(250);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let pg = null;
let nextChild = null;
let mock = null;

async function main() {
  // ---- 基础设施 -----------------------------------------------------------
  step('mock OpenAI 服务 + 独立内嵌 Postgres（.pgdata-e2e:54429）');
  mock = await startMockOpenAI();
  fs.rmSync(e2eDataDir, { recursive: true, force: true });
  pg = new EmbeddedPostgres({
    databaseDir: e2eDataDir,
    user: PG_USER,
    password: PG_PASSWORD,
    port: PG_PORT,
    persistent: true,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(PG_DATABASE);
  console.log(`  ✓ mock=${mock.baseUrl} db=${DATABASE_URL}`);

  step('应用数据库迁移（pnpm --filter @kur-river/db migrate）');
  await run('pnpm', ['--filter', '@kur-river/db', 'migrate'], {
    env: { ...process.env, DATABASE_URL },
    cwd: rootDir,
  });

  if (process.env.SKIP_BUILD !== '1') {
    step('构建 apps/web（SKIP_BUILD=1 可跳过）');
    await run('pnpm', ['--filter', '@kur-river/web', 'build'], { cwd: rootDir });
  }

  step('next start（带 APP_PASSWORD）');
  const webPort = await freePort();
  apiBase = `http://127.0.0.1:${webPort}`;
  const nextBin = path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  nextChild = spawn(process.execPath, [nextBin, 'start', '-p', String(webPort)], {
    cwd: webDir,
    env: { ...process.env, DATABASE_URL, APP_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  nextChild.stdout.on('data', () => {});
  nextChild.stderr.on('data', (c) => process.stderr.write(`[next] ${c}`));
  // 就绪探测
  {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const res = await fetch(`${apiBase}/api/health`);
        if (res.ok) break;
      } catch {
        /* 尚未就绪 */
      }
      if (Date.now() > deadline) throw new Error('next start 就绪超时');
      await sleep(500);
    }
  }
  console.log(`  ✓ web 就绪于 ${apiBase}`);

  step('密码门：无凭证 401 / health 公开 / 错误密码 401');
  {
    const noAuth = await fetch(`${apiBase}/`);
    assert(noAuth.status === 401, 'GET / 无凭证 → 401');
    assert(
      noAuth.headers.get('www-authenticate') === 'Basic realm="kur-river"',
      '401 携带 WWW-Authenticate: Basic realm="kur-river"',
    );
    const health = await fetch(`${apiBase}/api/health`);
    assert(health.status === 200, 'GET /api/health 无凭证 → 200');
    const badAuth = await fetch(`${apiBase}/`, {
      headers: { authorization: `Basic ${Buffer.from('x:wrong').toString('base64')}` },
    });
    assert(badAuth.status === 401, 'GET / 错误密码 → 401');
  }

  // ---- 剧组搭建 -----------------------------------------------------------
  step('建世界 / 角色（first_mes 带宏）/ 化身 / 团队 / 成员');
  const world = await apiOk('POST', '/api/worlds', {
    title: '边境',
    premise: '世界规则：{{user}} 与 {{char}} 在此相遇。',
  });
  const alice = await apiOk('POST', `/api/worlds/${world.id}/characters`, {
    name: 'Alice',
    card: {
      spec: 'chara_card_v2',
      data: {
        name: 'Alice',
        description: '银发剑士，龙血在身。',
        first_mes: '*拔剑* 「{{user}}，报上名来。」—— {{char}} 在此恭候。',
      },
    },
    secrets: '左臂有龙形刺青',
  });
  const persona = await apiOk('POST', `/api/worlds/${world.id}/personas`, {
    name: '导演',
    description: '拿着场记板的人',
  });
  const troupe = await apiOk('POST', '/api/troupes', {
    worldId: world.id,
    name: '一团',
    toneDirective: '本团走悬疑风',
    defaultPersonaId: persona.id,
  });
  await apiOk('POST', `/api/troupes/${troupe.id}/members`, { characterId: alice.id });

  // ---- mock 连接 / 预设 / 全局默认（§5.5） --------------------------------
  step('LLM 连接（指向 mock）/ models 透传 / apiKey 脱敏 / 预设 / settings 默认');
  const conn = await apiOk('POST', '/api/providers/connections', {
    name: 'mock 连接',
    providerType: 'openai-compatible',
    baseUrl: mock.baseUrl,
    apiKey: 'sk-mock',
    defaultModel: 'mock-model',
  });
  assert(!('apiKey' in conn), '连接出参不含 apiKey 明文');
  assert(conn.hasApiKey === true, '连接出参 hasApiKey=true');
  const models = await apiOk('GET', `/api/providers/connections/${conn.id}/models`);
  assert(
    Array.isArray(models.models) && models.models.includes('mock-model'),
    'models 透传 adapter.listModels 结果',
  );
  const preset = await apiOk('POST', '/api/providers/presets', {
    name: '稳定叙事',
    params: { temperature: 0.3 },
  });
  await apiOk('PUT', '/api/settings', {
    defaultConnectionId: conn.id,
    defaultModel: 'mock-model',
  });

  // ---- 开场（§5.2.2） ------------------------------------------------------
  step('建场次（Alice 上场）→ 断言开场草稿 ready 且宏已替换');
  const session = await apiOk('POST', `/api/troupes/${troupe.id}/sessions`, {
    title: '第一幕',
    castCharacterIds: [alice.id],
  });
  const opening = session.openingDraft;
  assert(opening, '场次创建返回 openingDraft');
  assert(opening.status === 'ready', '开场草稿状态 ready');
  assert(opening.content.length === 1 && opening.content[0].visibility === 'public',
    '开场草稿为单 public 段落（M1 约定）');
  assert(
    opening.content[0].text.includes('导演，报上名来') &&
      opening.content[0].text.includes('Alice 在此恭候') &&
      !opening.content[0].text.includes('{{'),
    '开场草稿宏替换完成（{{user}}→导演，{{char}}→Alice，无裸宏）',
  );

  step('confirm 开场草稿 → seq=1');
  {
    const { message } = await apiOk('POST', `/api/drafts/${opening.id}/confirm`);
    assert(message.seq === 1, '开场消息 seq=1');
    assert(message.senderType === 'character' && message.senderId === alice.id,
      '开场消息 senderType=character、senderId=Alice');
    assert(
      JSON.stringify(message.visibleTo) === JSON.stringify([alice.id]),
      'visibleTo 为当时在场名单快照',
    );
  }

  // ---- 导演直接发言（§2.2 直接落盘路径） ----------------------------------
  step('POST messages 导演旁白：落盘前宏替换、单 public 段落、seq=2');
  {
    const msg = await apiOk('POST', `/api/sessions/${session.id}/messages`, {
      senderType: 'director',
      text: '幕启：{{char}} 环顾四周，{{user}} 按下场记板。',
    });
    assert(msg.seq === 2, '旁白 seq=2');
    assert(msg.senderType === 'director' && msg.senderId === null, 'director 消息无 senderId');
    assert(
      msg.content[0].text === '幕启：Alice 环顾四周，导演 按下场记板。',
      '旁白落盘前完成宏替换（库里不存裸宏）',
    );
    assert(msg.content[0].visibility === 'public', '直接落盘默认单 public 段落');
  }

  // ---- 草稿生成（§5.6 + §5.5 快照 + §5.2.1 role 映射） ---------------------
  step('POST 带 directive 的草稿（走 settings 默认连接）→ 轮询 ready');
  let draft1;
  {
    const created = await apiOk('POST', `/api/sessions/${session.id}/drafts`, {
      characterId: alice.id,
      directive: '让 {{char}} 对 {{user}} 拔剑的动机说两句',
    });
    assert(created.status === 'queued', '草稿创建即 queued');
    assert(created.resolvedConnectionId === conn.id, '快照：settings 默认连接回退命中');
    assert(created.resolvedModel === 'mock-model', '快照：默认模型');
    draft1 = await pollDraft(created.id, ['ready', 'failed']);
    assert(draft1.status === 'ready', '流式生成完成置 ready');
    assert(draft1.content[0].text === MOCK_TEXT, `草稿内容含 mock 流式全文（${MOCK_TEXT}）`);
    assert(draft1.directive.includes('{{char}}'), 'directive 原文存于草稿（不落盘）');
  }

  step('核对 mock 收到的组装上下文（§5.2 / §5.2.1）');
  {
    const body = mock.state.lastChatBody;
    assert(body && body.stream === true, 'chat/completions 请求 stream=true');
    const msgs = body.messages;
    assert(msgs[0].role === 'system' && msgs[1].role === 'system', '两条 system 开头');
    assert(
      msgs[0].content.includes('世界规则：导演 与 Alice 在此相遇'),
      'system1：premise 宏替换（{{user}}/{{char}}）',
    );
    assert(msgs[0].content.includes('本团走悬疑风'), 'system1：团队基调注入');
    assert(msgs[1].content.includes('银发剑士') && msgs[1].content.includes('左臂有龙形刺青'),
      'system2：角色卡 + secrets（仅本人上下文）');
    assert(msgs[1].content.includes('输出契约'), 'system2：输出契约注入（§5.7 ①）');
    const opening = msgs.find((m) => m.role === 'assistant');
    assert(opening && opening.content.includes('拔剑') && !opening.content.startsWith('Alice:'),
      '历史：本人消息 → assistant（无名字前缀，§5.2.1）');
    const narration = msgs.find((m) => m.role === 'user' && m.content.startsWith('旁白: '));
    assert(
      narration && narration.content === '旁白: 幕启：Alice 环顾四周，导演 按下场记板。',
      '历史：导演旁白 → user + "旁白: " 前缀（§5.2.1）',
    );
    const last = msgs.at(-1);
    assert(
      last.role === 'user' && last.content === '[导演指令] 让 Alice 对 导演 拔剑的动机说两句',
      'directive 收尾为最后一条 user 且宏替换',
    );
  }

  step('PATCH 编辑（ready 态）→ confirm → seq=3');
  {
    const edited = await apiOk('PATCH', `/api/drafts/${draft1.id}`, {
      text: '改过的台词：剑指向导演。',
    });
    assert(edited.status === 'ready' && edited.content[0].text === '改过的台词：剑指向导演。',
      'PATCH 替换文本（单 public 段落化）');
    const { message } = await apiOk('POST', `/api/drafts/${draft1.id}/confirm`);
    assert(message.seq === 3, '确认后 seq=3（事务内 max(seq)+1）');
    assert(message.content[0].text === '改过的台词：剑指向导演。', '落盘内容为导演编辑后文本');
  }

  // ---- 失败与重抽（§5.6 failed → regenerate） ------------------------------
  step('mock 注入 500 → 草稿 failed + error 保留 → regenerate 成功 → confirm');
  {
    mock.state.failNext = true;
    const created = await apiOk('POST', `/api/sessions/${session.id}/drafts`, {
      characterId: alice.id,
      presetId: preset.id,
    });
    const failed = await pollDraft(created.id, ['failed', 'ready']);
    assert(failed.status === 'failed', '上游 500 → 草稿置 failed');
    assert(typeof failed.error === 'string' && failed.error.includes('500'),
      `failed 草稿保留 error（含 HTTP 500）：${failed.error}`);
    assert(failed.resolvedParams && failed.resolvedParams.temperature === 0.3,
      '快照：预设参数解析入库（temperature=0.3）');

    const regen = await apiOk('POST', `/api/drafts/${failed.id}/regenerate`);
    assert(regen.status === 'queued' && regen.id !== failed.id, 'regenerate 产出一个新 queued 草稿');
    const ready2 = await pollDraft(regen.id, ['ready', 'failed']);
    assert(ready2.status === 'ready' && ready2.content[0].text === MOCK_TEXT, '重抽成功置 ready');
    assert(ready2.resolvedParams && ready2.resolvedParams.temperature === 0.3,
      'regenerate 沿用模型配置快照（预设参数保留）');
    const { message } = await apiOk('POST', `/api/drafts/${ready2.id}/confirm`);
    assert(message.seq === 4, '重抽确认后 seq=4');

    const rejected = await api('POST', `/api/drafts/${ready2.id}/regenerate`);
    assert(rejected.status === 400, 'confirmed 草稿不可重抽（400）');
  }

  // ---- 历史回看（§2.2 导演指令不落盘） -------------------------------------
  step('GET messages：seq 连续、无 directive 落盘消息');
  {
    const list = await apiOk('GET', `/api/sessions/${session.id}/messages?limit=100`);
    assert(list.map((m) => m.seq).join(',') === '1,2,3,4', '消息 seq 连续（1,2,3,4）');
    assert(
      !list.some((m) => JSON.stringify(m.content).includes('拔剑的动机')),
      '导演指令不落盘：历史中没有 directive 内容产生的 director 消息',
    );
    assert(list.filter((m) => m.senderType === 'director').length === 1,
      '唯一一条 director 消息是显式旁白（seq=2）');
  }

  console.log('\n[e2e] M1 E2E OK');
}

// ---------------------------------------------------------------------------
// 启动与清理
// ---------------------------------------------------------------------------

async function teardown() {
  killTree(nextChild);
  if (mock) await new Promise((r) => mock.server.close(r));
  if (pg) {
    try {
      await pg.stop();
    } catch {
      /* 忽略停止错误 */
    }
  }
  // Windows 下 postgres 释放文件句柄有延迟，重试几次
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(e2eDataDir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
}

main()
  .catch((err) => {
    if (process.exitCode !== 1) {
      console.error('\n[e2e] ✗ 执行异常：', err);
      process.exitCode = 1;
    }
  })
  .finally(async () => {
    await teardown();
    // 保险丝：清理残留 next-server（killTree 偶尔杀不干净时兜底）
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/IM', 'next-server.exe'], { stdio: 'ignore' });
    }
    process.exit(process.exitCode ?? 0);
  });
