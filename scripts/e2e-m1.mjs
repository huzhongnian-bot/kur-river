#!/usr/bin/env node
// M1 端到端验证（DESIGN §8 M1 验收：能完整演一场单人戏）。
// 零依赖（node 原生 http/child_process/fetch）。
//
// 流程：
//   1. 起 mock OpenAI 服务（127.0.0.1:4100）：/v1/models 与 SSE 流式 /v1/chat/completions
//   2. build apps/web，用 3100 端口起 next start（APP_PASSWORD 取自根 .env.local）
//   3. 全程 fetch + Basic Auth：建世界 → 角色(first_mes) → 化身 → 连接 → 预设 →
//      全局默认 → 团队+成员 → 场次+上场 → 断言 ready 开场草稿 → confirm(seq 1)
//      → POST draft(走向窗边) → 轮询 ready（内容 == mock 全文）→ confirm(seq 2)
//      → POST 导演消息(seq 3)。每步断言，失败非零退出。
//
// 用法：node scripts/e2e-m1.mjs
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'apps', 'web');
const MOCK_PORT = 4100;
const WEB_PORT = 3100;
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;

// mock 模型流式返回的角色台词（M2 起 finalize 过 §5.7 契约解析：
// *动作* → action/public 段，「台词」 → speech/public 段）
const MOCK_MODEL = 'mock-model-1';
const MOCK_FULL_TEXT = '*她缓步走到窗边，抬手拨开厚重的窗帘。*\n「导演，这场戏我早就准备好了。」';
const MOCK_SEGMENTS = [
  { kind: 'action', text: '她缓步走到窗边，抬手拨开厚重的窗帘。', visibility: 'public' },
  { kind: 'speech', text: '导演，这场戏我早就准备好了。', visibility: 'public' },
];
const MOCK_CHUNKS = ['*她缓步走', '到窗边，抬手拨', '开厚重的窗帘。*\n「导演，', '这场戏我早就', '准备好了。」'];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stepNo = 0;
function step(title) {
  stepNo += 1;
  console.log(`\n[${String(stepNo).padStart(2, '0')}] ${title}`);
}
function ok(detail) {
  console.log(`     ✓ ${detail}`);
}
function assert(cond, message) {
  if (!cond) throw new Error(`断言失败：${message}`);
}

/** 根 .env.local 读 APP_PASSWORD / DATABASE_URL（next.config.ts 同款约定） */
function loadRootEnv() {
  const env = {};
  for (const name of ['.env.local', '.env']) {
    try {
      for (const line of readFileSync(path.join(ROOT, name), 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && env[m[1]] === undefined) env[m[1]] = m[2];
      }
    } catch {
      // 文件不存在则跳过
    }
  }
  return env;
}

const rootEnv = loadRootEnv();
const APP_PASSWORD = process.env.APP_PASSWORD ?? rootEnv.APP_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL ?? rootEnv.DATABASE_URL;
if (!APP_PASSWORD) throw new Error('缺少 APP_PASSWORD（根 .env.local 或环境变量）');
if (!DATABASE_URL) throw new Error('缺少 DATABASE_URL（根 .env.local 或环境变量）');

const AUTH = `Basic ${Buffer.from(`director:${APP_PASSWORD}`).toString('base64')}`;

async function api(method, pathName, payload) {
  const res = await fetch(`${WEB_BASE}${pathName}`, {
    method,
    headers: {
      Authorization: AUTH,
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${method} ${pathName} → HTTP ${res.status}，响应非 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`${method} ${pathName} → HTTP ${res.status}：${data?.error ?? text.slice(0, 200)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// mock OpenAI 服务
// ---------------------------------------------------------------------------

function startMockOpenAI() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL, object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      void (async () => {
        for (const chunk of MOCK_CHUNKS) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: chunk } }] })}\n\n`,
          );
          await sleep(60); // 拉开块间隔，覆盖 ~500ms 节流 flush 路径
        }
        res.write(
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 128, completion_tokens: 32, total_tokens: 160 },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      })();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock 未实现：${req.method} ${req.url}` } }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// web 服务（build → next start :3100）
// ---------------------------------------------------------------------------

function buildWeb() {
  // 直接调 next 的 JS 入口：Windows 上 spawn pnpm.cmd（shell:false）会 EINVAL
  const nextBin = path.join(WEB_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
  const result = spawnSync(process.execPath, [nextBin, 'build'], {
    cwd: WEB_DIR,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) throw new Error(`next build 失败（exit ${result.status}）`);
}

function startWeb() {
  const nextBin = path.join(WEB_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(WEB_PORT)], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      APP_PASSWORD,
      DATABASE_URL,
      PATH: process.env.PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`     [web] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`     [web!] ${d}`));
  return child;
}

function stopWeb(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    if (process.platform === 'win32') {
      // taskkill /T 杀整棵进程树（next start 会再起 worker）
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
    setTimeout(resolve, 5000).unref();
  });
}

async function waitForWeb(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${WEB_BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // 尚未就绪
    }
    await sleep(400);
  }
  throw new Error(`web 服务 ${timeoutMs}ms 内未就绪（:${WEB_PORT}）`);
}

async function pollDraft(draftId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let draft;
  do {
    draft = await api('GET', `/api/drafts/${draftId}`);
    if (draft.status === 'ready' || draft.status === 'failed') return draft;
    await sleep(300);
  } while (Date.now() < deadline);
  throw new Error(`草稿 ${draftId} ${timeoutMs}ms 内未到 ready/failed（当前 ${draft.status}）`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let mockServer;
let webChild;

async function main() {
  step('起 mock OpenAI 服务（127.0.0.1:4100）');
  mockServer = await startMockOpenAI();
  ok('GET /v1/models 与 SSE /v1/chat/completions 就绪');

  step('构建 apps/web（next build）');
  buildWeb();
  ok('build 通过');

  step(`起 next start（:${WEB_PORT}，Basic Auth）`);
  webChild = await startWeb();
  await waitForWeb();
  ok('/api/health OK');

  step('建世界书');
  const world = await api('POST', '/api/worlds', {
    title: `M1 验收世界 ${new Date().toISOString()}`,
    premise: '一座常年落雨的临江小城。',
  });
  assert(world.id, '返回世界 id');
  ok(`world ${world.id}`);

  step('建角色（卡含 first_mes，带 {{char}}/{{user}} 宏）');
  const character = await api('POST', `/api/worlds/${world.id}/characters`, {
    name: '沈青梧',
    card: {
      description: '小城剧团的台柱，沉静克制。',
      personality: '外冷内热',
      scenario: '雨夜排练厅',
      first_mes: '「{{user}}，你来了。我是{{char}}——今晚这出戏，由我开场。」',
      mes_example: '',
    },
    secrets: '她其实不会游泳。',
    talkativeness: 0.7,
  });
  assert(character.id, '返回角色 id');
  ok(`character ${character.id}`);

  step('建化身');
  const persona = await api('POST', `/api/worlds/${world.id}/personas`, {
    name: '林导',
    description: '严格的年轻导演。',
  });
  ok(`persona ${persona.id}`);

  step('建 LLM 连接（指向 mock）并拉取模型列表');
  const connection = await api('POST', '/api/providers/connections', {
    name: 'e2e-mock',
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    apiKey: 'mock-key',
    defaultModel: MOCK_MODEL,
  });
  assert(!('apiKey' in connection), '连接出参不回传 apiKey 明文');
  const models = await api('GET', `/api/providers/connections/${connection.id}/models`);
  assert(JSON.stringify(models.models) === JSON.stringify([MOCK_MODEL]), '模型列表透传');
  ok(`models = [${models.models.join(', ')}]`);

  step('建采样预设并设全局默认（连接+模型+预设）');
  const preset = await api('POST', '/api/providers/presets', {
    name: 'e2e-稳定叙事',
    params: { temperature: 0.7, maxTokens: 512 },
  });
  const settings = await api('PUT', '/api/settings', {
    defaultConnectionId: connection.id,
    defaultModel: MOCK_MODEL,
    defaultPresetId: preset.id,
  });
  assert(settings.defaultConnectionId === connection.id, '全局默认连接生效');
  ok('settings OK');

  step('建团队 + 成员');
  const troupe = await api('POST', '/api/troupes', {
    worldId: world.id,
    name: '雨夜剧团',
    toneDirective: '本团走克制悬疑风。',
    defaultPersonaId: persona.id,
  });
  const members = await api('POST', `/api/troupes/${troupe.id}/members`, {
    characterId: character.id,
  });
  assert(members.includes(character.id), '成员加入团队');
  ok(`troupe ${troupe.id}`);

  step('建场次 + 上场 → 断言出现 ready 开场草稿（§5.2.2，宏已替换）');
  const session = await api('POST', `/api/troupes/${troupe.id}/sessions`, {
    title: '第一场：排练厅',
    scene: '雨夜，旧排练厅，一盏顶灯。',
    castCharacterIds: [character.id],
  });
  const opening = session.openingDraft;
  assert(opening, '场次创建返回开场草稿');
  assert(opening.status === 'ready', `开场草稿 ready（实际 ${opening.status}）`);
  const openingText = opening.content?.[0]?.text ?? '';
  assert(openingText.includes('林导'), '开场白 {{user}} → 林导');
  assert(openingText.includes('沈青梧'), '开场白 {{char}} → 沈青梧');
  assert(!openingText.includes('{{'), '库里不存裸宏');
  ok(`开场草稿：「${openingText}」`);

  step('确认开场草稿 → GET messages 有 seq 1');
  const confirmed1 = await api('POST', `/api/drafts/${opening.id}/confirm`);
  assert(confirmed1.message.seq === 1, '开场落盘 seq 1');
  const msgs1 = await api('GET', `/api/sessions/${session.id}/messages`);
  assert(msgs1.length === 1 && msgs1[0].seq === 1, 'messages 现 1 条');
  assert(msgs1[0].visibleTo.includes(character.id), 'visibleTo 为在场名单快照');
  ok('seq 1 OK');

  step('POST draft（directive「走向窗边」）→ 轮询到 ready，段落 == mock 契约解析结果');
  const draft = await api('POST', `/api/sessions/${session.id}/drafts`, {
    characterId: character.id,
    directive: '走向窗边',
  });
  assert(['queued', 'generating'].includes(draft.status), '草稿立即返回（queued/generating）');
  assert(draft.resolvedConnectionId === connection.id, '快照：连接');
  assert(draft.resolvedModel === MOCK_MODEL, '快照：模型');
  assert(draft.resolvedParams?.temperature === 0.7, '快照：预设参数');
  const done = await pollDraft(draft.id);
  assert(done.status === 'ready', `生成成功（实际 ${done.status}：${done.error ?? ''}）`);
  assert(
    JSON.stringify(done.content) === JSON.stringify(MOCK_SEGMENTS),
    `终稿段落与 mock 全文的契约解析一致\n       期望：${JSON.stringify(MOCK_SEGMENTS)}\n       实际：${JSON.stringify(done.content)}`,
  );
  ok(`生成全文：「${MOCK_FULL_TEXT.replace(/\n/g, '⏎')}」→ ${done.content.length} 段`);

  step('确认生成草稿 → messages 有 seq 2');
  const confirmed2 = await api('POST', `/api/drafts/${draft.id}/confirm`);
  assert(confirmed2.message.seq === 2, '生成落盘 seq 2');
  const msgs2 = await api('GET', `/api/sessions/${session.id}/messages`);
  assert(msgs2.length === 2 && msgs2[1].seq === 2, 'messages 现 2 条');
  ok('seq 2 OK');

  step('POST 导演消息（含宏）→ seq 3，落盘前宏替换');
  const directorMsg = await api('POST', `/api/sessions/${session.id}/messages`, {
    senderType: 'director',
    text: '顶灯忽闪了一下，{{char}}的影子投在窗玻璃上。',
  });
  assert(directorMsg.seq === 3, '导演消息 seq 3');
  const directorText = directorMsg.content?.[0]?.text ?? '';
  assert(directorText.includes('沈青梧') && !directorText.includes('{{'), '直接落盘路径宏替换（§2.2）');
  const msgs3 = await api('GET', `/api/sessions/${session.id}/messages`);
  assert(msgs3.length === 3, 'messages 现 3 条');
  ok('seq 3 OK');

  console.log('\n========================================');
  console.log('M1 端到端验证全部通过（13 步断言全绿）');
  console.log('========================================');
}

try {
  await main();
} catch (err) {
  console.error(`\n✗ E2E 失败：${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  if (webChild) await stopWeb(webChild);
  if (mockServer) await new Promise((r) => mockServer.close(r));
}
