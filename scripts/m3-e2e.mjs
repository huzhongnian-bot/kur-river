// M3 端到端验收：角色记得上一场的事；剧情可回滚（DESIGN §8 M3 验收）。
// 不起 UI、不走真实 LLM：可编程 mock OpenAI（生成走响应队列；记忆摘要请求
// 走确定性 handler——回显剧情中的【标记】token，摘要内容由此可断言；
// 可注入"摘要连续失败 N 次"）。独立内嵌 PG（随机端口，跑完删除）。
// DB 断言直接连测试库（createRequire 借 packages/db 的 postgres.js）。
// 覆盖：归档摘要 / 记忆注入与跨团队隔离 / 摘要失败重试与补算 / 消息编辑 /
// 截断重演 / 归档后修订重算 + epoch 重建 / epoch 滚动合并。全绿输出 "M3 E2E OK"。

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import EmbeddedPostgres from 'embedded-postgres';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(rootDir, 'apps', 'web');
const e2eDataDir = path.join(rootDir, '.pgdata-e2e-m3');

const requireFromDb = createRequire(path.join(rootDir, 'packages', 'db', 'package.json'));
const postgres = requireFromDb('postgres');

const APP_PASSWORD = 'e2e-m3-pw';
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

async function waitFor(cond, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cond();
    if (value && (!Array.isArray(value) || value.length > 0)) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await sleep(250);
  }
}

// ---------------------------------------------------------------------------
// 可编程 mock OpenAI（生成走队列；记忆摘要走确定性 handler）
// ---------------------------------------------------------------------------

function startMockOpenAI() {
  const state = {
    queue: [],
    requests: [],
    /** 摘要请求连续失败次数（每次摘要请求递减） */
    failSummaryCount: 0,
    summaryFailures: 0,
    summaryRequests: 0,
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
        const body = JSON.parse(raw);
        state.requests.push(body);
        const isSummary = body.messages.some((m) => m.content.includes('记忆摘要'));
        let text;
        if (isSummary) {
          state.summaryRequests++;
          if (state.failSummaryCount > 0) {
            state.failSummaryCount--;
            state.summaryFailures++;
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'mock 注入摘要失败', code: 500 } }));
            return;
          }
          // 确定性摘要：回显**用户消息**中的【标记】token（证明摘要内容随源变化；
          // 只取 user——system 提示词的【记忆摘要】若回显会污染摘要文本，
          // 反过来触发上方 isSummary 误判：生成报文的记忆层含摘要文本）
          const source = body.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content)
            .join('\n');
          const tokens = [...source.matchAll(/【[^】]+】/g)].map((m) => m[0]);
          text = `摘要：${tokens.length > 0 ? tokens.join('，') : '静场'}`;
        } else {
          text = state.queue.length > 0 ? state.queue.shift() : '*静场。* 「……」';
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 } })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
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
// API / DB 驱动
// ---------------------------------------------------------------------------

let apiBase = '';
let sql = null;

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
    if (draft.status === 'failed') throw new Error(`草稿 ${id} 生成失败：${draft.error}`);
    if (Date.now() > deadline) throw new Error(`草稿 ${id} 轮询超时（${draft.status}）`);
    await sleep(250);
  }
}

const promptText = (reqBody) =>
  reqBody.messages.map((m) => `${m.role}\n${m.content}`).join('\n----\n');

/** 该角色 × 团队的全部记忆记录（DB 直查，升序） */
function memoriesOf(characterId, troupeId) {
  return sql`
    select * from memories
    where character_id = ${characterId} and troupe_id = ${troupeId}
    order by created_at asc`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let pg = null;
let nextChild = null;
let mock = null;

async function main() {
  step('基础设施：mock + 独立内嵌 PG + migrate + next start + DB 直连');
  mock = await startMockOpenAI();
  fs.rmSync(e2eDataDir, { recursive: true, force: true });
  const pgPort = await freePort();
  const databaseUrl = `postgresql://postgres:postgres@localhost:${pgPort}/kur_river_m3`;
  sql = postgres(databaseUrl, { max: 4 });
  pg = new EmbeddedPostgres({
    databaseDir: e2eDataDir,
    user: 'postgres',
    password: 'postgres',
    port: pgPort,
    persistent: true,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('kur_river_m3');
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

  step('剧组：世界/化身/双角色/双团队（跨团队隔离对照）/连接');
  const world = await apiOk('POST', '/api/worlds', { title: '边境' });
  await apiOk('POST', `/api/worlds/${world.id}/personas`, { name: '导演' });
  const alice = await apiOk('POST', `/api/worlds/${world.id}/characters`, {
    name: 'Alice',
    card: { data: { name: 'Alice', description: '银发剑士。' } },
  });
  const bob = await apiOk('POST', `/api/worlds/${world.id}/characters`, {
    name: 'Bob',
    card: { data: { name: 'Bob', description: '蓝袍法师。' } },
  });
  const troupe = await apiOk('POST', '/api/troupes', { worldId: world.id, name: '一团' });
  await apiOk('POST', `/api/troupes/${troupe.id}/members`, { characterId: alice.id });
  await apiOk('POST', `/api/troupes/${troupe.id}/members`, { characterId: bob.id });
  const troupe2 = await apiOk('POST', '/api/troupes', { worldId: world.id, name: '二团' });
  await apiOk('POST', `/api/troupes/${troupe2.id}/members`, { characterId: alice.id });
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

  // -----------------------------------------------------------------------
  step('① 场次 1：对手戏 + 悬挂草稿 + session 级条目 → 归档');
  const threshold = { memoryMergeThreshold: 3 };
  const s1 = await apiOk('POST', `/api/troupes/${troupe.id}/sessions`, {
    title: 'S1',
    settings: threshold,
    castCharacterIds: [alice.id, bob.id],
  });
  await apiOk('POST', `/api/sessions/${s1.id}/messages`, {
    senderType: 'director',
    text: '幕启【幕一】。',
  });
  mock.state.queue.push('*A1 动作。* 「A1 台词【亮点A1】。」');
  {
    const d = await apiOk('POST', `/api/sessions/${s1.id}/drafts`, { characterId: alice.id });
    const ready = await pollDraft(d.id);
    await apiOk('POST', `/api/drafts/${ready.id}/confirm`);
  }
  mock.state.queue.push('*B1 动作。* 「B1 台词【亮点B1】。」');
  {
    const d = await apiOk('POST', `/api/sessions/${s1.id}/drafts`, { characterId: bob.id });
    const ready = await pollDraft(d.id);
    await apiOk('POST', `/api/drafts/${ready.id}/confirm`);
  }
  // 悬挂 ready 草稿（不确认）
  mock.state.queue.push('*挂起。* 「未完成。」');
  const hanging = await apiOk('POST', `/api/sessions/${s1.id}/drafts`, { characterId: alice.id });
  await pollDraft(hanging.id);
  // session 级世界书条目（API 不开 session scope，DB 直插）
  await sql`
    insert into lorebook_entries (owner_type, owner_id, visibility, keys, content, position, enabled)
    values ('session', ${s1.id}, 'public', array['幕'], '场次限定条目', 'before_char', true)`;

  const arch = await apiOk('POST', `/api/sessions/${s1.id}/archive`);
  assert(arch.session.status === 'archived' && arch.alreadyArchived === false, '归档置 status=archived');
  assert(arch.discardedDrafts === 1, '悬挂 ready 草稿被统一 discard（M2 遗留清理）');
  assert(arch.disabledEntries === 1, 'session 级条目批量 enabled=false（§2.2）');
  {
    const draft = await apiOk('GET', `/api/drafts/${hanging.id}`);
    assert(draft.status === 'discarded', '悬挂草稿状态落库为 discarded');
    const [entry] = await sql`select enabled from lorebook_entries where owner_id = ${s1.id}`;
    assert(entry.enabled === false, 'DB 直查：session 条目已失效');
  }

  step('①b 归档摘要（§2.2 Memory）：每个在场角色一条，内容=本人可见段落');
  {
    for (const [cid, who] of [[alice.id, 'A'], [bob.id, 'B']]) {
      const records = await waitFor(
        async () =>
          (await memoriesOf(cid, troupe.id)).filter(
            (r) => r.session_id === s1.id && r.kind === 'session',
          ),
        `${who} 的 S1 摘要记录`,
      );
      assert(records.length === 1, `${who}：S1 恰好一条 (character, troupe, session) 摘要（实际 ${records.length} 条：${JSON.stringify(records.map((r) => ({ id: r.id.slice(0, 8), kind: r.kind, summary: r.summary.slice(0, 30) })))}）`);
      assert(
        records[0].summary.includes('【亮点A1】') && records[0].summary.includes('【亮点B1】'),
        `${who} 摘要覆盖双方 public 台词`,
      );
    }
    // 幂等 + 无缺失：再次归档不补算
    const again = await apiOk('POST', `/api/sessions/${s1.id}/archive`);
    assert(again.alreadyArchived === true && again.healingSummaries === 0,
      '已归档场次再归档：幂等 200 且无补算');
  }

  step('② 记忆注入（§5.2 ④）：同团队场次 2 报文含 S1 摘要；跨团队隔离');
  const s2 = await apiOk('POST', `/api/troupes/${troupe.id}/sessions`, {
    title: 'S2',
    settings: threshold,
    castCharacterIds: [alice.id, bob.id],
  });
  let mark = mock.state.requests.length;
  mock.state.queue.push('「S2 的台词。」');
  {
    const d = await apiOk('POST', `/api/sessions/${s2.id}/drafts`, { characterId: alice.id });
    const ready = await pollDraft(d.id);
    const prompt = promptText(mock.state.requests[mark]);
    assert(prompt.includes('【亮点A1】'), 'S2 报文：含 S1 摘要内容——角色记得上一场（§8 验收）');
    await apiOk('POST', `/api/drafts/${ready.id}/confirm`);
  }
  // 跨团队：同一角色在二团的场次，报文不得含一团记忆
  const sx = await apiOk('POST', `/api/troupes/${troupe2.id}/sessions`, {
    title: 'Sx',
    castCharacterIds: [alice.id],
  });
  mark = mock.state.requests.length;
  mock.state.queue.push('「二团的戏。」');
  {
    const d = await apiOk('POST', `/api/sessions/${sx.id}/drafts`, { characterId: alice.id });
    const ready = await pollDraft(d.id);
    const prompt = promptText(mock.state.requests[mark]);
    assert(!prompt.includes('【亮点A1】'), '跨团队记忆默认隔离（§2.2）：二团报文不含一团摘要');
    await apiOk('POST', `/api/drafts/${ready.id}/discard`);
  }

  step('④ 消息编辑（active 场次）：PATCH 后新文本进后续报文');
  {
    const msgs = await apiOk('GET', `/api/sessions/${s2.id}/messages?limit=10`);
    const target = msgs.find((m) => m.seq === 1);
    await apiOk('PATCH', `/api/sessions/${s2.id}/messages/${target.id}`, {
      text: '「S2 的台词（改【补丁S2】）。」',
    });
    mark = mock.state.requests.length;
    mock.state.queue.push('「B 接着说。」');
    const d = await apiOk('POST', `/api/sessions/${s2.id}/drafts`, { characterId: bob.id });
    const ready = await pollDraft(d.id);
    const prompt = promptText(mock.state.requests[mark]);
    assert(prompt.includes('补丁S2') && !prompt.includes('S2 的台词。」'), 'PATCH active 消息：后续报文用编辑后文本（§7.1）');
    await apiOk('POST', `/api/drafts/${ready.id}/confirm`);
  }

  step('⑤ 截断重演（§7.1）：truncate 到 seq=2 → 之后消息删除、悬挂草稿 discard');
  {
    await apiOk('POST', `/api/sessions/${s2.id}/messages`, {
      senderType: 'director',
      text: '这一幕要重拍。',
    });
    mock.state.queue.push('*新反应。* 「嗯。」');
    const hangingDraft = await apiOk('POST', `/api/sessions/${s2.id}/drafts`, { characterId: alice.id });
    await pollDraft(hangingDraft.id);
    const res = await apiOk('POST', `/api/sessions/${s2.id}/messages/truncate`, { seq: 2 });
    assert(res.deleted === 1, 'truncate 删除 seq>2 的消息 1 条');
    assert(res.discardedDrafts === 1, 'truncate 统一 discard 悬挂草稿');
    const msgs = await apiOk('GET', `/api/sessions/${s2.id}/messages?limit=10`);
    assert(msgs.every((m) => m.seq <= 2), '截断后消息全部 ≤ seq=2');
  }
  await apiOk('POST', `/api/sessions/${s2.id}/archive`);

  step('③ 摘要失败路径：连续失败 → 重试仍败 → 记错误；补算入口（archive 幂等）恢复');
  const s3 = await apiOk('POST', `/api/troupes/${troupe.id}/sessions`, {
    title: 'S3',
    settings: threshold,
    castCharacterIds: [alice.id, bob.id],
  });
  mock.state.queue.push('「S3 的台词【亮点S3】。」');
  {
    const d = await apiOk('POST', `/api/sessions/${s3.id}/drafts`, { characterId: alice.id });
    const ready = await pollDraft(d.id);
    await apiOk('POST', `/api/drafts/${ready.id}/confirm`);
  }
  // A 的摘要首次 + 重试都失败（摘要按在场顺序 A 先 B 后，两次失败都落在 A 上）
  mock.state.failSummaryCount = 2;
  await apiOk('POST', `/api/sessions/${s3.id}/archive`);
  {
    const bRecords = await waitFor(
      async () =>
        (await memoriesOf(bob.id, troupe.id)).filter(
          (r) => r.session_id === s3.id && r.kind === 'session',
        ),
      'B 的 S3 摘要',
    );
    assert(bRecords.length === 1, 'B 的 S3 摘要成功（未受 A 失败影响）');
    await waitFor(() => mock.state.summaryFailures >= 2, '摘要失败被实际注入');
    const aMissing = (await memoriesOf(alice.id, troupe.id)).filter(
      (r) => r.session_id === s3.id && r.kind === 'session',
    );
    assert(aMissing.length === 0, 'A 的 S3 摘要重试后仍失败：无记录（不硬造错误数据）');
    // 补算：已归档场次再 POST archive → 幂等 200 + 为缺失角色重触发
    const heal = await apiOk('POST', `/api/sessions/${s3.id}/archive`);
    assert(heal.alreadyArchived === true && heal.healingSummaries === 1,
      '补算入口：幂等归档返回 healingSummaries=1（缺失角色重触发）');
    const aRecords = await waitFor(
      async () =>
        (await memoriesOf(alice.id, troupe.id)).filter(
          (r) => r.session_id === s3.id && r.kind === 'session',
        ),
      'A 的 S3 摘要（补算后）',
    );
    assert(aRecords.length === 1 && aRecords[0].summary.includes('【亮点S3】'),
      `补算成功：A 的 S3 摘要落库（实际 ${aRecords.length} 条：${JSON.stringify(aRecords.map((r) => r.summary))}）`);
  }

  step('⑦ epoch 滚动合并（阈值 3）：归档第 4 场 → 最旧 1 条并入 epoch，原始记录保留');
  const s4 = await apiOk('POST', `/api/troupes/${troupe.id}/sessions`, {
    title: 'S4',
    settings: threshold,
    castCharacterIds: [alice.id, bob.id],
  });
  mock.state.queue.push('「S4 的台词【亮点S4】。」');
  {
    const d = await apiOk('POST', `/api/sessions/${s4.id}/drafts`, { characterId: alice.id });
    const ready = await pollDraft(d.id);
    await apiOk('POST', `/api/drafts/${ready.id}/confirm`);
  }
  await apiOk('POST', `/api/sessions/${s4.id}/archive`);
  {
    const epoch = await waitFor(async () => {
      const rows = (await memoriesOf(alice.id, troupe.id)).filter((r) => r.kind === 'epoch');
      return rows.length > 0 ? rows[0] : null;
    }, 'A 的 epoch 记录');
    assert(epoch.covers_count === 1, 'epoch 覆盖最旧 1 条（4 场 - 阈值 3）');
    const sessions = (await memoriesOf(alice.id, troupe.id)).filter((r) => r.kind === 'session');
    assert(sessions.length === 4, '原始 session 摘要全部保留（epoch 只是读取优化，§2.2 v0.4）');
    assert(epoch.summary.includes('【亮点A1】'), 'epoch 摘要内容滚动自最旧场次');
  }

  step('⑥ 归档后修订（§2.2 v0.4）：PATCH 已归档 S1 → 摘要重算 + epoch 连带重建');
  {
    const msgs = await apiOk('GET', `/api/sessions/${s1.id}/messages?limit=10`);
    const target = msgs.find((m) => m.seq === 2);
    const patched = await apiOk('PATCH', `/api/sessions/${s1.id}/messages/${target.id}`, {
      segments: [
        { kind: 'speech', text: '「A1 台词（修订【补丁S1】）。」', visibility: 'public' },
      ],
    });
    assert(patched.memoryRecompute === true, '已归档场次 PATCH 返回 memoryRecompute=true');
    const aS1 = await waitFor(async () => {
      const rows = (await memoriesOf(alice.id, troupe.id)).filter(
        (r) => r.session_id === s1.id && r.kind === 'session' && r.summary.includes('补丁S1'),
      );
      return rows.length > 0 ? rows : null;
    }, 'A 的 S1 摘要被重算（含补丁）');
    assert(aS1.length === 1, 'S1 摘要重算后仍恰一条');
    const epoch = await waitFor(async () => {
      const rows = (await memoriesOf(alice.id, troupe.id)).filter(
        (r) => r.kind === 'epoch' && r.summary.includes('补丁S1'),
      );
      return rows.length > 0 ? rows[0] : null;
    }, 'epoch 连带重建（S1 已并入 epoch）');
    assert(epoch.covers_count === 1, 'epoch 重建后覆盖数不变');
  }

  step('⑦b 记忆读取连贯：新场次报文 = epoch（含补丁）+ 最近场次摘要');
  const s5 = await apiOk('POST', `/api/troupes/${troupe.id}/sessions`, {
    title: 'S5',
    settings: threshold,
    castCharacterIds: [alice.id, bob.id],
  });
  mark = mock.state.requests.length;
  mock.state.queue.push('「S5 的台词。」');
  {
    const d = await apiOk('POST', `/api/sessions/${s5.id}/drafts`, { characterId: alice.id });
    const ready = await pollDraft(d.id);
    const prompt = promptText(mock.state.requests[mark]);
    assert(prompt.includes('补丁S1'), 'S5 报文：epoch（含归档后修订内容）注入——角色记得被改过的剧情');
    assert(prompt.includes('【亮点S4】'), 'S5 报文：含最近场次（S4）摘要');
    assert(prompt.includes('【亮点S3】'), 'S5 报文：含 S3 摘要');
    await apiOk('POST', `/api/drafts/${ready.id}/discard`);
  }

  console.log('\n[e2e] M3 E2E OK');
}

// ---------------------------------------------------------------------------
// 启动与清理
// ---------------------------------------------------------------------------

async function teardown() {
  killTree(nextChild);
  if (mock) await new Promise((r) => mock.server.close(r));
  if (sql) await sql.end().catch(() => {});
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
