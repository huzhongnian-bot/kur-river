// M2 端到端验收：信息不对称可演示（DESIGN §8 M2 验收）。
// 不起 UI、不走真实 LLM：内建可编程 mock OpenAI（响应队列 + 报文录制 +
// 可注入 500），独立内嵌 Postgres（随机端口，跑完删除），next start 随机端口。
// 覆盖：secrets 隔离 / 两级可见性过滤 / 输出契约解析 + 越权裁剪 + fail-closed /
// 段落定密 / 补发可见性 / 依次反应严格串行与批上限 / character 级条目 public-private。
// 任一断言失败非零退出；全绿输出 "M2 E2E OK"。

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(rootDir, 'apps', 'web');
const e2eDataDir = path.join(rootDir, '.pgdata-e2e-m2');

const APP_PASSWORD = 'e2e-m2-pw';
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
// 可编程 mock OpenAI
// ---------------------------------------------------------------------------

function startMockOpenAI() {
  const state = {
    /** 响应文本队列（FIFO）；空时返回默认契约文本 */
    queue: [],
    /** 全部 chat/completions 请求体（组装报文录制），按到达顺序 */
    requests: [],
    failNext: false,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        state.requests.push(JSON.parse(raw));
        if (state.failNext) {
          state.failNext = false;
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock 注入 500', code: 500 } }));
          return;
        }
        const text = state.queue.length > 0 ? state.queue.shift() : '*静场。* 「……」';
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const half = Math.ceil(text.length / 2);
        const chunks = [text.slice(0, half), text.slice(half)];
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
              `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 99, completion_tokens: 9, total_tokens: 108 } })}\n\n`,
            );
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }, 15);
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

async function api(method, p, body) {
  const res = await fetch(`${apiBase}${p}`, {
    method,
    headers: {
      authorization: AUTH,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  assert(
    expect.includes(status),
    `${method} ${p} → ${status}（${JSON.stringify(data)?.slice(0, 300)}）`,
  );
  return data;
}

async function pollDraft(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const draft = await apiOk('GET', `/api/drafts/${id}`);
    if (draft.status === 'ready') return draft;
    if (draft.status === 'failed') {
      throw new Error(`草稿 ${id} 生成失败：${draft.error}`);
    }
    if (Date.now() > deadline) throw new Error(`草稿 ${id} 轮询超时（${draft.status}）`);
    await sleep(250);
  }
}

/** 等条件成真（异步任务同步用），超时抛错 */
async function waitFor(cond, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await sleep(200);
  }
}

/** 录制的第 mark 条报文 → 拼成全文字符串便于 contains 断言 */
function promptText(reqBody) {
  return reqBody.messages.map((m) => `${m.role}\n${m.content}`).join('\n----\n');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let pg = null;
let nextChild = null;
let mock = null;

async function main() {
  step('基础设施：mock OpenAI + 独立内嵌 PG + migrate + next start');
  mock = await startMockOpenAI();
  fs.rmSync(e2eDataDir, { recursive: true, force: true });
  const pgPort = await freePort();
  const databaseUrl = `postgresql://postgres:postgres@localhost:${pgPort}/kur_river_m2`;
  pg = new EmbeddedPostgres({
    databaseDir: e2eDataDir,
    user: 'postgres',
    password: 'postgres',
    port: pgPort,
    persistent: true,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('kur_river_m2');
  await run('pnpm', ['--filter', '@kur-river/db', 'migrate'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    cwd: rootDir,
  });
  if (process.env.SKIP_BUILD !== '1') {
    await run('pnpm', ['--filter', '@kur-river/web', 'build'], { cwd: rootDir });
  }
  const webPort = await freePort();
  apiBase = `http://127.0.0.1:${webPort}`;
  const nextBin = path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  nextChild = spawn(process.execPath, [nextBin, 'start', '-p', String(webPort)], {
    cwd: webDir,
    env: { ...process.env, DATABASE_URL: databaseUrl, APP_PASSWORD },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
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
  {
    const noAuth = await fetch(`${apiBase}/`);
    assert(noAuth.status === 401, '密码门：无凭证 401');
  }

  step('剧组：世界/化身/双角色（各带 secrets + 卡文本关键词）/团队/成员');
  const world = await apiOk('POST', '/api/worlds', { title: '边境', premise: '边境世界。' });
  const persona = await apiOk('POST', `/api/worlds/${world.id}/personas`, { name: '导演' });
  const alice = await apiOk('POST', `/api/worlds/${world.id}/characters`, {
    name: 'Alice',
    card: {
      data: {
        name: 'Alice',
        description: '银发剑士，身负誓言，左臂有刺青。',
        first_mes: '*按剑而立* 「我是 Alice。」',
      },
    },
    secrets: '龙形刺青秘密A',
  });
  const bob = await apiOk('POST', `/api/worlds/${world.id}/characters`, {
    name: 'Bob',
    card: { data: { name: 'Bob', description: '蓝袍法师。' } },
    secrets: '海妖血统秘密B',
  });
  const troupe = await apiOk('POST', '/api/troupes', {
    worldId: world.id,
    name: '双人团',
    defaultPersonaId: persona.id,
  });
  await apiOk('POST', `/api/troupes/${troupe.id}/members`, { characterId: alice.id });
  await apiOk('POST', `/api/troupes/${troupe.id}/members`, { characterId: bob.id });
  // character 级条目：public（誓言）对全员生效；private（刺青）仅本人（§2.2）
  await apiOk('POST', `/api/worlds/${world.id}/lorebook`, {
    ownerType: 'character',
    ownerId: alice.id,
    visibility: 'public',
    keys: ['誓言'],
    content: 'Alice 的公开条目：她是誓言骑士。',
    position: 'before_char',
  });
  await apiOk('POST', `/api/worlds/${world.id}/lorebook`, {
    ownerType: 'character',
    ownerId: alice.id,
    visibility: 'private',
    keys: ['刺青'],
    content: 'Alice 的私密条目：刺青会发光。',
    position: 'after_char',
  });
  const conn = await apiOk('POST', '/api/providers/connections', {
    name: 'mock',
    providerType: 'openai-compatible',
    baseUrl: mock.baseUrl,
    apiKey: 'sk-mock',
    defaultModel: 'mock-model',
  });
  await apiOk('PUT', '/api/settings', {
    defaultConnectionId: conn.id,
    defaultModel: 'mock-model',
  });

  step('场次（A/B 在场）→ 开场草稿确认 seq=1 → 导演旁白 seq=2');
  const session = await apiOk('POST', `/api/troupes/${troupe.id}/sessions`, {
    title: '对演',
    castCharacterIds: [alice.id, bob.id],
  });
  assert(session.openingDraft?.status === 'ready', '开场草稿 ready（首位上场 Alice）');
  {
    const { message } = await apiOk('POST', `/api/drafts/${session.openingDraft.id}/confirm`);
    assert(message.seq === 1, '开场落盘 seq=1');
  }
  await apiOk('POST', `/api/sessions/${session.id}/messages`, {
    senderType: 'director',
    text: '幕启：誓言与刺青的传说在城墙回荡。',
  });

  step('① A 生成（契约格式输出）：段落切分 + 默认可见性 + secrets/条目注入本人');
  let mark = mock.state.requests.length;
  mock.state.queue.push('*她按住剑柄。* 「誓言之剑不染尘埃。」（刺青又在发烫，不能让别人看见。）');
  {
    const created = await apiOk('POST', `/api/sessions/${session.id}/drafts`, {
      characterId: alice.id,
    });
    const draft = await pollDraft(created.id);
    assert(draft.content.length === 3, '契约解析切成 3 段');
    assert(
      draft.content[0].kind === 'action' && draft.content[0].visibility === 'public' &&
      draft.content[1].kind === 'speech' && draft.content[1].visibility === 'public' &&
      draft.content[2].kind === 'thought' && draft.content[2].visibility === 'self_director',
      '默认可见性：speech/action→public、thought→self_director（§5.7 ②）',
    );
    const prompt = promptText(mock.state.requests[mark]);
    assert(prompt.includes('龙形刺青秘密A'), 'A 报文：含本人 secrets');
    assert(prompt.includes('刺青会发光'), 'A 报文：含本人 private 条目（§2.2）');
    assert(prompt.includes('誓言骑士'), 'A 报文：含 public 条目');
    assert(!prompt.includes('海妖血统秘密B'), 'A 报文：不含 B 的 secrets');
    const { message } = await apiOk('POST', `/api/drafts/${draft.id}/confirm`);
    assert(message.seq === 3, 'A 契约草稿落盘 seq=3');
  }

  step('② B 生成：secrets 隔离 + 条目 public/private 区分 + thought 被滤（§2.2/§2.3）');
  mark = mock.state.requests.length;
  mock.state.queue.push('*蓝袍微动。* 「Bob 静观其变。」');
  {
    const created = await apiOk('POST', `/api/sessions/${session.id}/drafts`, {
      characterId: bob.id,
    });
    const draft = await pollDraft(created.id);
    const prompt = promptText(mock.state.requests[mark]);
    assert(!prompt.includes('龙形刺青秘密A'), 'B 报文：不含 A 的 secrets（§2.2 输入侧隔离）');
    assert(prompt.includes('海妖血统秘密B'), 'B 报文：含本人 secrets');
    assert(prompt.includes('誓言骑士'), 'B 报文：A 的 public 条目在场全员生效（§2.2）');
    assert(!prompt.includes('刺青会发光'), 'B 报文：A 的 private 条目仅本人（§2.2）');
    assert(prompt.includes('誓言之剑不染尘埃'), 'B 历史：可见 A 的 public 台词');
    assert(!prompt.includes('刺青又在发烫'), 'B 历史：A 的 thought 被第二级过滤（§2.3）');
    await apiOk('POST', `/api/drafts/${draft.id}/confirm`);
  }

  step('③ A 再生成：本人历史保留 self_director 心声（§2.3 角色记得自己想过什么）');
  mark = mock.state.requests.length;
  mock.state.queue.push('「继续。」');
  {
    const created = await apiOk('POST', `/api/sessions/${session.id}/drafts`, {
      characterId: alice.id,
    });
    const draft = await pollDraft(created.id);
    const prompt = promptText(mock.state.requests[mark]);
    assert(prompt.includes('刺青又在发烫'), 'A 历史：本人的 self_director 段落保留');
    await apiOk('POST', `/api/drafts/${draft.id}/confirm`);
  }

  step('④ 越权裁剪：mock 让 A 代写 B 的台词 → 截断 + outputTruncated 提示位（§5.7 ②）');
  mock.state.queue.push('「我来做决定。」\nBob: 「我反对。」\n*两人争执不休。');
  {
    const created = await apiOk('POST', `/api/sessions/${session.id}/drafts`, {
      characterId: alice.id,
    });
    const draft = await pollDraft(created.id);
    const allText = draft.content.map((s) => s.text).join('\n');
    assert(allText.includes('我来做决定'), '越权裁剪：保留 A 自己的部分');
    assert(!allText.includes('我反对') && !allText.includes('争执不休'),
      '越权裁剪：从代写行截断，B 的"台词"不进草稿');
    assert(draft.outputTruncated === true, 'GET draft 派生 outputTruncated=true 提示位');
    await apiOk('POST', `/api/drafts/${draft.id}/confirm`);
  }

  step('⑤ fail-closed：不遵契约的乱文本 → 单 self_director 段（§5.7 ② 不退回 public）');
  mock.state.queue.push('这是一段完全不遵守输出契约的混乱文本没有任何标记');
  {
    const created = await apiOk('POST', `/api/sessions/${session.id}/drafts`, {
      characterId: bob.id,
    });
    const draft = await pollDraft(created.id);
    assert(draft.content.length === 1, 'fail-closed：降为单段');
    assert(
      draft.content[0].kind === 'thought' && draft.content[0].visibility === 'self_director',
      'fail-closed：self_director（不默认进全员上下文）',
    );
    await apiOk('POST', `/api/drafts/${draft.id}/confirm`);
  }

  step('⑥ 段落定密：PATCH 把某段改 director → 落盘后角色不可见、导演视图可见（§5.7 ③）');
  mock.state.queue.push('*挥手。* 「看招。」');
  {
    const created = await apiOk('POST', `/api/sessions/${session.id}/drafts`, {
      characterId: bob.id,
    });
    const draft = await pollDraft(created.id);
    assert(draft.content.length === 2, '定密前：两段均 public');
    const segments = [
      { ...draft.content[0], visibility: 'director' },
      draft.content[1],
    ];
    await apiOk('PATCH', `/api/drafts/${draft.id}`, { segments });
    const { message } = await apiOk('POST', `/api/drafts/${draft.id}/confirm`);
    assert(message.content[0].visibility === 'director', '落盘段落带定密后的 director 可见性');
    const directorView = await apiOk('GET', `/api/sessions/${session.id}/messages?limit=50`);
    const landed = directorView.find((m) => m.seq === message.seq);
    assert(
      landed.content.some((s) => s.text === '挥手。'),
      '导演视图（messages GET）可见 director 段落',
    );
    // 生成侧验证：B 本人与 A 的报文里都不该出现 director 段
    for (const [cid, who] of [[bob.id, 'B 本人'], [alice.id, 'A']]) {
      mark = mock.state.requests.length;
      mock.state.queue.push('「嗯。」');
      const d = await apiOk('POST', `/api/sessions/${session.id}/drafts`, { characterId: cid });
      const polled = await pollDraft(d.id);
      const prompt = promptText(mock.state.requests[mark]);
      assert(!prompt.includes('挥手。'), `${who} 报文：director 段不可见`);
      assert(prompt.includes('看招。'), `${who} 报文：public 段可见`);
      await apiOk('POST', `/api/drafts/${polled.id}/discard`);
    }
  }

  step('⑦ C 中途上场：看不到上场前剧情 → grant-visibility 后可见 public 段（§2.2 快照语义）');
  const carol = await apiOk('POST', `/api/worlds/${world.id}/characters`, {
    name: 'Carol',
    card: { data: { name: 'Carol', description: '游侠。' } },
    secrets: '游侠秘密C',
  });
  await apiOk('POST', `/api/troupes/${troupe.id}/members`, { characterId: carol.id });
  await apiOk('POST', `/api/sessions/${session.id}/cast`, { characterId: carol.id });
  mark = mock.state.requests.length;
  mock.state.queue.push('「你们好。」');
  {
    const d = await apiOk('POST', `/api/sessions/${session.id}/drafts`, { characterId: carol.id });
    const polled = await pollDraft(d.id);
    const prompt = promptText(mock.state.requests[mark]);
    assert(!prompt.includes('誓言之剑') && !prompt.includes('幕启'), 'C 报文：上场前消息不可见（快照语义）');
    await apiOk('POST', `/api/drafts/${polled.id}/discard`);
  }
  {
    const { granted } = await apiOk('POST', `/api/sessions/${session.id}/messages/grant-visibility`, {
      characterId: carol.id,
    });
    assert(granted > 0, `grant-visibility 授权 ${granted} 条历史消息`);
    mark = mock.state.requests.length;
    mock.state.queue.push('「了解了。」');
    const d = await apiOk('POST', `/api/sessions/${session.id}/drafts`, { characterId: carol.id });
    const polled = await pollDraft(d.id);
    const prompt = promptText(mock.state.requests[mark]);
    assert(prompt.includes('誓言之剑不染尘埃'), '补发后：C 可见历史 public 台词');
    assert(prompt.includes('幕启：誓言与刺青的传说'), '补发后：C 可见导演旁白');
    assert(!prompt.includes('刺青又在发烫'), '补发后：self_director 仍按第二级过滤（授权只改消息级）');
    assert(!prompt.includes('挥手。'), '补发后：director 段仍不可见');
    await apiOk('POST', `/api/drafts/${polled.id}/discard`);
  }

  step('⑧ 依次反应（§5.4）：批上限 cap=2、严格串行、编辑后上下文、cancel 语义');
  {
    const before = mock.state.requests.length;
    mock.state.queue.push('*A 的反应。* 「A 先说。」');
    const batch = await apiOk('POST', `/api/sessions/${session.id}/reactions`, {
      directive: '各自表态',
      cap: 2,
    });
    assert(batch.batch.total === 2, '批上限 cap=2 生效（在场 3 人截断为 2）');
    assert(batch.progress.current === 1 && batch.progress.currentCharacterId === alice.id,
      '批次从在场名单首位（Alice）开始');
    // A 的生成是进程内异步任务，先等其报文到达
    await waitFor(() => mock.state.requests.length === before + 1, 'A 的批次生成报文');
    const draftA = await pollDraft(batch.draft.id);
    // 严格串行：A 的草稿确认前，B 不得开始生成
    assert(mock.state.requests.length === before + 1, '串行：A 未确认前 B 不得开始生成');
    // 导演编辑 A 后再确认 → B 的上下文必须用编辑后版本
    const edited = draftA.content.map((s) =>
      s.kind === 'speech' ? { ...s, text: '「A 先说（导演改）。」' } : s,
    );
    await apiOk('PATCH', `/api/drafts/${draftA.id}`, { segments: edited });
    const confirmRes = await apiOk('POST', `/api/drafts/${draftA.id}/confirm`);
    assert(confirmRes.reaction?.touched === true && confirmRes.reaction?.finished === false,
      'confirm 触发批次推进（未耗尽）');
    assert(confirmRes.reaction?.nextDraft?.characterId === bob.id, '推进后为 B 建生成草稿');
    mock.state.queue.push('「B 附和。」');
    const draftB = await pollDraft(confirmRes.reaction.nextDraft.id);
    const promptB = promptText(mock.state.requests.at(-1));
    assert(promptB.includes('A 先说（导演改）'), 'B 报文：包含 A 已确认（且编辑后）的反应——严格串行');
    const confirmB = await apiOk('POST', `/api/drafts/${draftB.id}/confirm`);
    assert(confirmB.reaction?.finished === true, '队列耗尽：批次收尾（cap=2 不含 C）');
    const s = await apiOk('GET', `/api/sessions/${session.id}`);
    assert(s.reactionProgress === null, '批次结束后 reactionProgress 清空');
    // cancel 语义
    mock.state.queue.push('*A 再来。* 「嗯。」');
    const again = await apiOk('POST', `/api/sessions/${session.id}/reactions`, { cap: 1 });
    assert(again.batch.total === 1, '再次发起批次 cap=1');
    const cancel = await apiOk('POST', `/api/sessions/${session.id}/reactions/cancel`);
    assert(cancel.wasActive === true, 'cancel 返回 wasActive=true');
    const s2 = await apiOk('GET', `/api/sessions/${session.id}`);
    assert(s2.reactionProgress === null, 'cancel 后批次清除（当前草稿保留可处置）');
    const orphan = await pollDraft(again.draft.id);
    await apiOk('POST', `/api/drafts/${orphan.id}/discard`);
  }

  console.log('\n[e2e] M2 E2E OK');
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
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/IM', 'next-server.exe'], { stdio: 'ignore' });
    }
    process.exit(process.exitCode ?? 0);
  });
