#!/usr/bin/env node
// M2 端到端验证（DESIGN §8 M2 验收：信息不对称可演示）。
// 零依赖（node 原生 http/child_process/fetch），复用 e2e-m1 的起停模式：
// mock OpenAI（127.0.0.1:4100，SSE 流式，**记录每次请求 body** 供断言，
// 按调用顺序消费脚本化回复）→ build apps/web → 3100 端口 next start（Basic Auth）。
//
// 双角色：A 沈青梧（secrets + character 级 public/private 世界书条目各一）、
// B 白芷（晚加入，走补发可见性）。断言矩阵：
//   ① 解析：草稿段落切分与默认可见性（*动作*→action/public，「台词」→speech/public，
//      （心声）→thought/self_director）
//   ② 信息不对称：B 的生成 body 不含 A 心声/secrets、含 A public 文本；
//      A 的生成 body 含自己的心声与 secrets
//   ③ castPublicScopes：B 的生成 body 含 A 的 public 条目、不含 A 的 private 条目
//   ④ 越权裁剪：A 输出 "白芷：..." 行 → outputTruncated 且段落在该行前截断
//   ⑤ fail-closed：无契约标记文本 → 单 self_director 段
//   ⑥ 定密：PATCH 把 thought 段改 public → confirm → B 的下次生成 body 含该段文本
//   ⑦ 补发可见性：B 晚加入时 body 不含加入前 public 消息 → grant → 含
//   ⑧ 依次反应（§5.4 严格串行）：批次只有 A 草稿 → confirm → 自动出现 B 草稿
//      且其 body 含 A 刚确认的消息 → B confirm 后批次清空；活跃批次重复发起 409；
//      cancel 清批次保留当前草稿
// 每步断言失败即非零退出。
//
// 用法：node scripts/e2e-m2.mjs
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

const MOCK_MODEL = 'mock-model-1';

// 标记串（断言信息不对称用，各自唯一）
const SECRET_A = 'SECRET-A-青梧卧底';
const PUB_ENTRY_A = 'PUB-ENTRY-A-左眉有疤';
const PRIV_ENTRY_A = 'PRIV-ENTRY-A-袖袋钥匙';
const THOUGHT_A1 = 'THOUGHT-A1-钥匙在袖袋里发烫';
const THOUGHT_A2 = 'THOUGHT-A2-他们快查到我头上了';

// 脚本化回复（按生成调用顺序消费；每条对应一次 /v1/chat/completions）
const RESP_A1 = `*她望向窗外的雨。*「这场雨，下进我心里了。」（${THOUGHT_A1}。）`;
const RESP_B1 = '雨声渐密，两人都没有说话。'; // 无契约标记 → fail-closed
const RESP_B2 = '*白芷拨了个弦音。*「这雨，倒像戏里的锣鼓点。」';
const RESP_A2 = `*她攥紧衣袖。*「雨怕是停不了了。」（${THOUGHT_A2}。）\n白芷：「别躲了，我看见你了。」`;
const RESP_B3 = '*白芷垂眸。*「锣鼓点歇了。」';
const RESP_A3 = '*她抬头望天。*「雨更急了！」';
const RESP_B4 = '*白芷往檐下缩了缩。*「先避一避。」';
const RESP_A4 = '*她拢了拢披风。*「先这样吧。」';
const SCRIPT = [RESP_A1, RESP_B1, RESP_B2, RESP_A2, RESP_B3, RESP_A3, RESP_B4, RESP_A4];

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

/** 根 .env.local 读 APP_PASSWORD / DATABASE_URL（与 e2e-m1 同款约定） */
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

/** 不检查状态码的原始请求（409 等负路径断言用） */
async function apiRaw(method, pathName, payload) {
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
    /* 非 JSON 保留 null */
  }
  return { status: res.status, data };
}

async function api(method, pathName, payload) {
  const { status, data } = await apiRaw(method, pathName, payload);
  if (status < 200 || status >= 300) {
    throw new Error(
      `${method} ${pathName} → HTTP ${status}：${data?.error ?? JSON.stringify(data)?.slice(0, 200)}`,
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// mock OpenAI 服务：记录每次 chat/completions 请求 body，按序消费 SCRIPT
// ---------------------------------------------------------------------------

const receivedBodies = []; // 每次请求的解析后 JSON body
/** 第 i 次生成请求的消息全文（断言上下文包含/不包含用） */
function bodyText(i) {
  assert(receivedBodies[i], `第 ${i + 1} 次生成请求已到达 mock（实际共 ${receivedBodies.length} 次）`);
  return JSON.stringify(receivedBodies[i].messages);
}

function startMockOpenAI() {
  let callNo = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL, object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        receivedBodies.push(body);
        const text = SCRIPT[callNo] ?? `（mock 脚本耗尽后的兜底回复，第 ${callNo + 1} 次调用）`;
        callNo += 1;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        void (async () => {
          // 两段流式，拉开间隔覆盖节流 flush 路径
          const mid = Math.ceil(text.length / 2);
          for (const chunk of [text.slice(0, mid), text.slice(mid)]) {
            res.write(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: chunk } }] })}\n\n`,
            );
            await sleep(60);
          }
          res.write(
            `data: ${JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 256, completion_tokens: 32, total_tokens: 288 },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
        })();
      });
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
    env: { ...process.env, APP_PASSWORD, DATABASE_URL, PATH: process.env.PATH },
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

/** 当前场次活跃（未完结）草稿 */
async function activeDrafts(sessionId) {
  const drafts = await api('GET', `/api/sessions/${sessionId}/drafts`);
  return drafts.filter((d) => ['queued', 'generating', 'ready', 'failed'].includes(d.status));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let mockServer;
let webChild;

async function main() {
  step('起 mock OpenAI 服务（127.0.0.1:4100，记录请求 body）');
  mockServer = await startMockOpenAI();
  ok('GET /v1/models 与 SSE /v1/chat/completions 就绪');

  step('构建 apps/web（next build）');
  buildWeb();
  ok('build 通过');

  step(`起 next start（:${WEB_PORT}，Basic Auth）`);
  webChild = await startWeb();
  await waitForWeb();
  ok('/api/health OK');

  // ---- 基建：世界 / 角色 / 化身 / 条目 / 连接 / 预设 / 团队 / 场次 ----------

  step('建世界书 + 双角色（A 沈青梧含 secrets 与 first_mes、B 白芷）+ 化身');
  const world = await api('POST', '/api/worlds', {
    title: `M2 验收世界 ${new Date().toISOString()}`,
    premise: '一座常年落雨的临江小城。',
  });
  const charA = await api('POST', `/api/worlds/${world.id}/characters`, {
    name: '沈青梧',
    card: {
      description: '小城剧团的台柱，沉静克制，雨中常客。',
      personality: '外冷内热',
      scenario: '雨夜排练厅',
      first_mes: '「{{user}}，你来了。我是{{char}}——雨夜这出戏，由我开场。」',
      mes_example: '',
    },
    secrets: SECRET_A,
  });
  const charB = await api('POST', `/api/worlds/${world.id}/characters`, {
    name: '白芷',
    card: {
      description: '剧团新来的琴师，总在雨夜练琴。',
      personality: '爽利',
      scenario: '雨夜排练厅',
      mes_example: '',
    },
  });
  const persona = await api('POST', `/api/worlds/${world.id}/personas`, {
    name: '林导',
    description: '严格的年轻导演。',
  });
  ok(`A=${charA.id} B=${charB.id}`);

  step('建 character 级世界书条目：A 的 public / private 各一（关键词「雨」）');
  await api('POST', `/api/worlds/${world.id}/lorebook`, {
    ownerType: 'character',
    ownerId: charA.id,
    visibility: 'public',
    keys: ['雨'],
    content: PUB_ENTRY_A,
    position: 'before_char',
  });
  await api('POST', `/api/worlds/${world.id}/lorebook`, {
    ownerType: 'character',
    ownerId: charA.id,
    visibility: 'private',
    keys: ['雨'],
    content: PRIV_ENTRY_A,
    position: 'before_char',
  });
  ok('条目就绪');

  step('建 LLM 连接（指向 mock）+ 预设 + 全局默认 + 团队（成员 A、B）');
  const connection = await api('POST', '/api/providers/connections', {
    name: 'e2e-m2-mock',
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    apiKey: 'mock-key',
    defaultModel: MOCK_MODEL,
  });
  const preset = await api('POST', '/api/providers/presets', {
    name: 'e2e-m2-预设',
    params: { temperature: 0.7, maxTokens: 512 },
  });
  await api('PUT', '/api/settings', {
    defaultConnectionId: connection.id,
    defaultModel: MOCK_MODEL,
    defaultPresetId: preset.id,
  });
  const troupe = await api('POST', '/api/troupes', {
    worldId: world.id,
    name: '雨夜剧团 M2',
    toneDirective: '本团走克制悬疑风。',
    defaultPersonaId: persona.id,
  });
  await api('POST', `/api/troupes/${troupe.id}/members`, { characterId: charA.id });
  await api('POST', `/api/troupes/${troupe.id}/members`, { characterId: charB.id });
  ok('连接/预设/默认/团队就绪');

  step('建场次（初始 cast 仅 A）→ 开场草稿 ready，确认落盘 seq 1');
  const session = await api('POST', `/api/troupes/${troupe.id}/sessions`, {
    title: 'M2：雨夜对手戏',
    scene: '雨夜，旧排练厅，一盏顶灯。',
    castCharacterIds: [charA.id],
  });
  const opening = session.openingDraft;
  assert(opening?.status === 'ready', '开场草稿 ready');
  assert(opening.content?.[0]?.text.includes('雨夜这出戏'), '开场白含标记文本');
  const confirmedOpening = await api('POST', `/api/drafts/${opening.id}/confirm`);
  assert(confirmedOpening.message.seq === 1, '开场落盘 seq 1');
  ok('seq 1 OK');

  // ---- ① 解析 + ② A 侧（自己的 secrets/private 条目） ----------------------

  step('① 解析：A 生成（*动作*「台词」（心声））→ 三段切分 + 默认可见性');
  const draftA1 = await api('POST', `/api/sessions/${session.id}/drafts`, {
    characterId: charA.id,
    directive: '以雨开场',
  });
  const doneA1 = await pollDraft(draftA1.id);
  assert(doneA1.status === 'ready', `A1 ready（实际 ${doneA1.status}：${doneA1.error ?? ''}）`);
  assert(doneA1.outputTruncated !== true, 'A1 未发生越权截断');
  const segsA1 = doneA1.content ?? [];
  assert(segsA1.length === 3, `A1 切分 3 段（实际 ${segsA1.length}）`);
  assert(segsA1[0].kind === 'action' && segsA1[0].visibility === 'public', 'A1[0] 动作/公开');
  assert(segsA1[0].text === '她望向窗外的雨。', 'A1[0] 文本（标记已剥离）');
  assert(segsA1[1].kind === 'speech' && segsA1[1].visibility === 'public', 'A1[1] 台词/公开');
  assert(segsA1[1].text === '这场雨，下进我心里了。', 'A1[1] 文本');
  assert(
    segsA1[2].kind === 'thought' && segsA1[2].visibility === 'self_director',
    'A1[2] 心声/本人+导演',
  );
  assert(segsA1[2].text.includes(THOUGHT_A1), 'A1[2] 心声文本');
  ok('① 段落切分与默认可见性正确');

  step('②（A 侧）：A 的生成 body 含自己的 secrets 与 public/private 条目');
  const body0 = bodyText(0);
  assert(body0.includes(SECRET_A), 'A 的上下文含自己的 secrets');
  assert(body0.includes(PUB_ENTRY_A), 'A 的上下文含自己的 public 条目');
  assert(body0.includes(PRIV_ENTRY_A), 'A 的上下文含自己的 private 条目');
  assert(body0.includes('输出契约'), '输出契约注入 system（§5.7 ①）');
  ok('② A 侧注入正确');

  step('确认 A1 → seq 2（心声段落落盘为 self_director）');
  const confirmedA1 = await api('POST', `/api/drafts/${draftA1.id}/confirm`);
  assert(confirmedA1.message.seq === 2, 'A1 落盘 seq 2');
  assert(
    confirmedA1.message.content[2].visibility === 'self_director',
    '落盘段落保持定密前默认可见性',
  );
  ok('seq 2 OK');

  // ---- ⑤ fail-closed + ⑦ 晚加入不可见 + ③ castPublicScopes -----------------

  step('B 上场（晚加入：看不到 seq 1-2 的剧情）');
  await api('POST', `/api/sessions/${session.id}/cast`, { characterId: charB.id });
  ok('B 在场');

  step('⑤ fail-closed：B 生成无标记文本 → 单 self_director 段');
  const draftB1 = await api('POST', `/api/sessions/${session.id}/drafts`, {
    characterId: charB.id,
    directive: '白芷望向沈青梧',
  });
  const doneB1 = await pollDraft(draftB1.id);
  const segsB1 = doneB1.content ?? [];
  assert(segsB1.length === 1, `B1 fail-closed 单段（实际 ${segsB1.length}）`);
  assert(segsB1[0].kind === 'thought' && segsB1[0].visibility === 'self_director', 'B1 段 心声/本人+导演');
  assert(segsB1[0].text === RESP_B1, 'B1 段文本为全文');
  ok('⑤ fail-closed 正确');

  step('⑦（前半）+ ③：B 的生成 body 不含加入前消息/secrets/private 条目，含 A 的 public 条目');
  const body1 = bodyText(1);
  assert(!body1.includes('雨夜这出戏'), 'B 看不到加入前的开场消息（seq 1）');
  assert(!body1.includes('这场雨，下进我心里了'), 'B 看不到加入前的 A1 消息（seq 2）');
  assert(!body1.includes(THOUGHT_A1), 'B 的上下文不含 A 心声');
  assert(!body1.includes(SECRET_A), 'B 的上下文不含 A 的 secrets');
  assert(body1.includes(PUB_ENTRY_A), '③ B 的上下文含 A 的 public 条目（castPublicScopes）');
  assert(!body1.includes(PRIV_ENTRY_A), '③ B 的上下文不含 A 的 private 条目');
  ok('⑦ 前半 + ③ 正确');
  await api('POST', `/api/drafts/${draftB1.id}/discard`);
  ok('B1 草稿放弃（无批次，reaction 不推进）');

  step('⑦（后半）：补发可见性 → B 的生成 body 含加入前 public 消息');
  const grant = await api('POST', `/api/sessions/${session.id}/messages/grant-visibility`, {
    characterId: charB.id,
  });
  assert(grant.granted === 2, `补发 2 条（seq 1-2），实际 ${grant.granted}`);
  const draftB2 = await api('POST', `/api/sessions/${session.id}/drafts`, {
    characterId: charB.id,
    directive: '接着方才的戏',
  });
  const doneB2 = await pollDraft(draftB2.id);
  assert(doneB2.status === 'ready', 'B2 ready');
  const body2 = bodyText(2);
  assert(body2.includes('雨夜这出戏'), 'grant 后 B 看到 seq 1 开场');
  assert(body2.includes('这场雨，下进我心里了'), 'grant 后 B 看到 seq 2 的 A 台词');
  assert(!body2.includes(THOUGHT_A1) && !body2.includes(SECRET_A), '但 A 心声/secrets 仍不可见');
  ok(`⑦ 补发可见性正确（granted=${grant.granted}）`);
  const confirmedB2 = await api('POST', `/api/drafts/${draftB2.id}/confirm`);
  assert(confirmedB2.message.seq === 3, 'B2 落盘 seq 3');
  ok('seq 3 OK');

  // ---- ④ 越权裁剪 + ②（B 侧完整） + ⑥ 定密 -------------------------------

  step('④ 越权裁剪：A 输出 "白芷：..." 行 → truncated 且段落在该行前截断');
  const draftA2 = await api('POST', `/api/sessions/${session.id}/drafts`, {
    characterId: charA.id,
    directive: '继续',
  });
  const doneA2 = await pollDraft(draftA2.id);
  assert(doneA2.outputTruncated === true, 'A2 outputTruncated 标记');
  const segsA2 = doneA2.content ?? [];
  assert(segsA2.length === 3, `A2 截断后 3 段（实际 ${segsA2.length}）`);
  assert(
    !segsA2.some((s) => s.text.includes('别躲了')),
    'A2 段落不含越权行内容（截断点在「白芷：」行首）',
  );
  ok('④ 越权裁剪正确');

  step('②（A 侧心声）：A 的生成 body 含自己上一条消息的心声');
  const body3 = bodyText(3);
  assert(body3.includes(THOUGHT_A1), 'A 记得自己的心声（self_director 对本人可见）');
  assert(body3.includes(SECRET_A), 'A 的上下文仍含自己的 secrets');
  ok('② A 侧心声可见性正确');

  step('⑥ 定密：PATCH 把 thought 段改 public → confirm(seq 4) → B 的生成 body 含该段');
  const patched = await api('PATCH', `/api/drafts/${draftA2.id}`, {
    segments: segsA2.map((s) =>
      s.kind === 'thought' ? { ...s, visibility: 'public' } : s,
    ),
  });
  assert(
    patched.content[2].visibility === 'public',
    'PATCH segments 生效（thought → public）',
  );
  const confirmedA2 = await api('POST', `/api/drafts/${draftA2.id}/confirm`);
  assert(confirmedA2.message.seq === 4, 'A2 落盘 seq 4');
  const draftB3 = await api('POST', `/api/sessions/${session.id}/drafts`, {
    characterId: charB.id,
    directive: '回应她的失态',
  });
  const doneB3 = await pollDraft(draftB3.id);
  assert(doneB3.status === 'ready', 'B3 ready');
  const body4 = bodyText(4);
  assert(body4.includes(THOUGHT_A2), '定密下放后 B 看到该段（原心声 → public）');
  assert(!body4.includes(THOUGHT_A1), '未下放的 A 心声 B 仍不可见');
  ok('⑥ 定密生效');
  const confirmedB3 = await api('POST', `/api/drafts/${draftB3.id}/confirm`);
  assert(confirmedB3.message.seq === 5, 'B3 落盘 seq 5');
  ok('seq 5 OK');

  // ---- ⑧ 依次反应（严格串行） ----------------------------------------------

  step('⑧ 依次反应：发起批次（A→B）→ 只有 A 的草稿；活跃批次重复发起 409');
  // §5.4「按在场名单顺序」：批次队列必须与 cast API 返回的在场名单同序
  const castNow = await api('GET', `/api/sessions/${session.id}/cast`);
  assert(
    castNow[0] === charA.id && castNow[1] === charB.id,
    `在场名单为上场顺序 [A, B]（实际 ${JSON.stringify(castNow)}）`,
  );
  const batchStart = await api('POST', `/api/sessions/${session.id}/reactions`, {
    directive: '雨忽然转急',
  });
  assert(batchStart.batch.queue.join() === castNow.join(), '批次队列按在场名单顺序');
  assert(batchStart.progress.current === 1 && batchStart.progress.total === 2, '批次进度 1/2');
  assert(batchStart.draft.characterId === charA.id, '首位反应角色是 A');
  const actives1 = await activeDrafts(session.id);
  assert(
    actives1.length === 1 && actives1[0].characterId === charA.id,
    '严格串行：只有 A 的草稿（B 未并行预生成）',
  );
  const dup = await apiRaw('POST', `/api/sessions/${session.id}/reactions`, {});
  assert(dup.status === 409, `活跃批次重复发起 → 409（实际 ${dup.status}）`);
  ok('批次发起 + 409 正确');

  step('⑧ A confirm → 自动出现 B 的草稿，其生成 body 含 A 刚确认的消息');
  const doneA3 = await pollDraft(batchStart.draft.id);
  assert(doneA3.status === 'ready', '批次 A 草稿 ready');
  const confirmedA3 = await api('POST', `/api/drafts/${batchStart.draft.id}/confirm`);
  assert(confirmedA3.message.seq === 6, '批次 A 落盘 seq 6');
  assert(confirmedA3.reaction?.touched === true, 'confirm 触发批次推进');
  assert(confirmedA3.reaction?.finished !== true, '批次未耗尽');
  const nextDraft = confirmedA3.reaction?.nextDraft;
  assert(nextDraft?.characterId === charB.id, '推进后为 B 建草稿');
  const sessionAfterA = await api('GET', `/api/sessions/${session.id}`);
  assert(
    sessionAfterA.reactionProgress?.current === 2 &&
      sessionAfterA.reactionProgress?.currentCharacterId === charB.id,
    'GET session 批次进度 2/2（当前 B）',
  );
  const doneB4 = await pollDraft(nextDraft.id);
  assert(doneB4.status === 'ready', '批次 B 草稿 ready');
  const body6 = bodyText(6);
  assert(body6.includes('雨更急了！'), 'B 的上下文含 A 刚确认落盘的反应（严格串行的意义）');
  assert(body6.includes('雨忽然转急'), '批次指令对后续角色共用');
  ok('⑧ 推进正确');

  step('⑧ B confirm → 批次清空');
  const confirmedB4 = await api('POST', `/api/drafts/${nextDraft.id}/confirm`);
  assert(confirmedB4.message.seq === 7, '批次 B 落盘 seq 7');
  assert(confirmedB4.reaction?.finished === true, '批次耗尽');
  const sessionAfterB = await api('GET', `/api/sessions/${session.id}`);
  assert(sessionAfterB.reactionProgress === null, 'reactionBatch 已清空');
  const msgs = await api('GET', `/api/sessions/${session.id}/messages`);
  assert(msgs.length === 7, `messages 共 7 条（实际 ${msgs.length}）`);
  ok('⑧ 批次收尾正确');

  step('⑧（补）cancel：单人批次发起后取消，清批次且当前草稿保留可处置');
  const batch2 = await api('POST', `/api/sessions/${session.id}/reactions`, {
    characterIds: [charA.id],
  });
  assert(batch2.draft.characterId === charA.id, '第二批次 A 草稿');
  const cancel = await api('POST', `/api/sessions/${session.id}/reactions/cancel`);
  assert(cancel.ok === true && cancel.wasActive === true, 'cancel 清掉活跃批次');
  const sessionAfterCancel = await api('GET', `/api/sessions/${session.id}`);
  assert(sessionAfterCancel.reactionProgress === null, 'cancel 后无批次进度');
  const doneA4 = await pollDraft(batch2.draft.id);
  assert(doneA4.status === 'ready', 'cancel 前已生成的草稿仍在（可处置）');
  const discardedA4 = await api('POST', `/api/drafts/${batch2.draft.id}/discard`);
  assert(discardedA4.reaction?.touched !== true, '批次已清，discard 不再推进');
  ok('cancel 语义正确');

  step('mock 脚本恰好消费完毕');
  assert(
    receivedBodies.length === SCRIPT.length,
    `共 ${SCRIPT.length} 次生成调用（实际 ${receivedBodies.length} 次）`,
  );
  ok('8 次生成调用，无多余 LLM 请求');

  console.log('\n========================================');
  console.log('M2 端到端验证全部通过（断言矩阵 ①-⑧ 全绿）');
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
