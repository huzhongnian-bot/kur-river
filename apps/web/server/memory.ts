// 记忆摘要服务（DESIGN §2.2 Memory、§5.2 ④、§7.1 archive/PATCH/truncate）。
//
// 摘要触发（进程内，§3/§5.6 进程内任务承载）：
// - session.archived 事件 → 对该场每个在场角色生成一条 (character, troupe, session) 摘要
// - 已归档场次的消息变更（PATCH/truncate）→ 该场摘要作废重算 + epoch 连带重建（§2.2 v0.4）
//
// 模型解析（DESIGN 未写明，按两级回退实现）：团队绑定 → 全局默认
//   （无角色级/单次覆盖——摘要是团队级后台任务，不走角色绑定；
//   采样参数取全局默认预设，无则空参数）。
//
// 失败处理：LLM 失败立即重试一次；再失败则放弃本次并在进程内登记错误
// （globalThis Map，抗 dev 热重载）。**补算入口**：POST archive 于已归档场次
// 是幂等 200，并为缺摘要的角色重触发（成功 = 记录存在，天然可检测，免状态列）。
import {
  DEFAULT_MEMORY_MERGE_THRESHOLD,
  renderMessageForReader,
  selectRecordsForEpoch,
  shouldRebuildEpoch,
  type Message,
  type Repos,
} from '@kur-river/core';
import { createTokenCounter, getAdapter } from '@kur-river/llm';
import type { ChatMessage, LlmConnection } from '@kur-river/llm';

// ---------------------------------------------------------------------------
// 提示词（server 侧常量）
// ---------------------------------------------------------------------------

/** 摘要长度上限（字符；超出由提示词约束，不做硬截断） */
export const SUMMARY_MAX_CHARS = 400;

/** 摘要请求的系统提示（mock/断言识别标记：含"记忆摘要"字样） */
export const SUMMARY_SYSTEM_PROMPT = [
  '【记忆摘要】你是跑团记录员。把一场戏中"指定角色"可见的剧情压缩成长期记忆。',
  `要求：第三人称、聚焦该角色视角亲历的事实与关系变化（不要旁白式全知）；不超过 ${SUMMARY_MAX_CHARS} 字；`,
  '只输出摘要正文，不要标题与解释。',
].join('\n');

/** "摘要的摘要"系统提示（epoch 合并） */
export const EPOCH_SYSTEM_PROMPT = [
  '【记忆摘要】你是跑团记录员。把同一角色在多场戏中的逐场摘要滚动合并为一条更早期的综合记忆。',
  `要求：第三人称、保留仍成立的事实与关键关系变化、丢弃已被推翻的旧状态；不超过 ${SUMMARY_MAX_CHARS} 字；`,
  '只输出摘要正文，不要标题与解释。',
].join('\n');

// ---------------------------------------------------------------------------
// 模型解析（团队绑定 → 全局默认）
// ---------------------------------------------------------------------------

async function resolveMemoryLlm(
  repos: Repos,
  troupeId: string,
): Promise<{ connection: LlmConnection; model: string; params: Record<string, unknown> }> {
  const troupe = await repos.troupes.get(troupeId);
  if (!troupe) throw new Error(`团队不存在：${troupeId}`);
  const global = await repos.settings.get();
  const connectionId = troupe.llmConnectionId ?? global?.defaultConnectionId ?? null;
  if (!connectionId) throw new Error('记忆摘要无法解析 LLM 连接：团队未绑定且全局默认未配置');
  const connection = await repos.llmConnections.get(connectionId);
  if (!connection) throw new Error(`记忆摘要的 LLM 连接不存在：${connectionId}`);
  if (!connection.enabled) throw new Error(`LLM 连接已停用：${connection.name}`);
  const model =
    troupe.model ?? global?.defaultModel ?? connection.defaultModel ?? null;
  if (!model) throw new Error(`记忆摘要无法解析模型（连接 ${connection.name}）`);
  const preset = global?.defaultPresetId
    ? await repos.generationPresets.get(global.defaultPresetId)
    : null;
  return { connection, model, params: { ...(preset?.params ?? {}) } };
}

// ---------------------------------------------------------------------------
// 失败登记（进程内；补算走 archive 幂等路径，不落状态列）
// ---------------------------------------------------------------------------

const globalForMemoryErrors = globalThis as unknown as {
  __kurRiverMemoryErrors?: Map<string, string>;
};
const memoryErrors = (globalForMemoryErrors.__kurRiverMemoryErrors ??= new Map<string, string>());

const errKey = (sessionId: string, characterId: string) => `${sessionId}:${characterId}`;

/** 该场各角色的摘要失败信息（无失败返回空对象） */
export function memoryErrorsOf(sessionId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, message] of memoryErrors) {
    if (key.startsWith(`${sessionId}:`)) out[key.slice(sessionId.length + 1)] = message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 摘要源与 LLM 调用
// ---------------------------------------------------------------------------

/** 该角色在场可见的段落文本（§2.2：他人 public + 本人 public/self_director；director 段永不进） */
export async function memorySourceFor(
  repos: Repos,
  sessionId: string,
  characterId: string,
): Promise<string> {
  const messages = await repos.messages.visibleTo(sessionId, characterId, { limit: 500 });
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.senderType === 'character' && m.senderId && !names.has(m.senderId)) {
      const c = await repos.characters.get(m.senderId);
      names.set(m.senderId, c?.name ?? '角色');
    }
  }
  const lines: string[] = [];
  for (const m of messages as Message[]) {
    const segments = renderMessageForReader(m, characterId);
    if (segments.length === 0) continue;
    const speaker =
      m.senderType === 'director'
        ? '旁白'
        : m.senderType === 'player'
          ? '玩家'
          : (m.senderId && names.get(m.senderId)) ?? '角色';
    lines.push(`${speaker}: ${segments.map((s) => s.text).join('\n')}`);
  }
  return lines.join('\n');
}

async function callSummaryLlm(
  repos: Repos,
  troupeId: string,
  messages: ChatMessage[],
): Promise<string> {
  const llm = await resolveMemoryLlm(repos, troupeId);
  const adapter = getAdapter(llm.connection.providerType);
  const result = await adapter.generate({
    connection: llm.connection,
    model: llm.model,
    messages,
    params: llm.params,
  });
  const text = result.text.trim();
  if (!text) throw new Error('LLM 返回空摘要');
  return text;
}

/** 失败重试一次；再失败上抛（调用方登记错误） */
async function callSummaryLlmWithRetry(
  repos: Repos,
  troupeId: string,
  messages: ChatMessage[],
): Promise<string> {
  try {
    return await callSummaryLlm(repos, troupeId, messages);
  } catch (firstErr) {
    console.warn('[memory] 摘要首次失败，重试一次：', firstErr instanceof Error ? firstErr.message : firstErr);
    return callSummaryLlm(repos, troupeId, messages);
  }
}

// ---------------------------------------------------------------------------
// 单场摘要 / 作废重算 / epoch 滚动合并
// ---------------------------------------------------------------------------

/** 为某角色生成该场摘要（失败登记并静默；成功则清错误并视情况触发 epoch 合并） */
export async function summarizeSessionFor(
  repos: Repos,
  input: { sessionId: string; troupeId: string; characterId: string },
): Promise<boolean> {
  const { sessionId, troupeId, characterId } = input;
  const key = errKey(sessionId, characterId);
  try {
    const source = await memorySourceFor(repos, sessionId, characterId);
    const character = await repos.characters.get(characterId);
    const summary = await callSummaryLlmWithRetry(repos, troupeId, [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `角色：${character?.name ?? characterId}\n\n该角色可见的剧情：\n${source || '（无）'}`,
      },
    ]);
    await repos.memories.append({ characterId, troupeId, sessionId, summary });
    memoryErrors.delete(key);
    await maybeRebuildEpoch(repos, characterId, troupeId, { sessionId });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    memoryErrors.set(key, message);
    console.error(`[memory] 摘要失败（session ${sessionId} / character ${characterId}）：${message}`);
    return false;
  }
}

/** session.archived 订阅者：对该场每个在场角色各生成一条摘要（进程内异步） */
export function summarizeArchivedSession(repos: Repos, sessionId: string, troupeId: string): void {
  void (async () => {
    const castIds = await repos.sessionCast.list(sessionId);
    for (const characterId of castIds) {
      await summarizeSessionFor(repos, { sessionId, troupeId, characterId });
    }
  })().catch((err) => console.error('[memory] 归档摘要任务异常：', err));
}

/**
 * 已归档场次消息变更（PATCH/truncate）→ 该场摘要作废重算（§2.2）：
 * 先删该场全部 session 摘要，再逐角色重算；若已有 epoch 则连带重建
 * （重算不改变条数，coversCount 不变，内容随新摘要滚动合并）。
 */
export function recomputeArchivedSession(repos: Repos, sessionId: string, troupeId: string): void {
  void (async () => {
    await repos.memories.deleteBySession(sessionId);
    const castIds = await repos.sessionCast.list(sessionId);
    for (const characterId of castIds) {
      await summarizeSessionFor(repos, { sessionId, troupeId, characterId });
    }
    for (const characterId of castIds) {
      const epoch = await repos.memories.getEpoch(characterId, troupeId);
      if (epoch) await rebuildEpoch(repos, characterId, troupeId, { sessionId });
    }
  })().catch((err) => console.error('[memory] 摘要重算任务异常：', err));
}

/** 场次 settings 的合并阈值（默认 10，§2.2 例值；E2E/调优可配小） */
async function mergeThresholdOf(repos: Repos, sessionId: string | undefined): Promise<number> {
  if (!sessionId) return DEFAULT_MEMORY_MERGE_THRESHOLD;
  const session = await repos.sessions.get(sessionId);
  const raw = session?.settings?.memoryMergeThreshold;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1
    ? raw
    : DEFAULT_MEMORY_MERGE_THRESHOLD;
}

/** 归档新摘要后：session 摘要超阈值 → 最旧若干条滚动合并进 epoch */
export async function maybeRebuildEpoch(
  repos: Repos,
  characterId: string,
  troupeId: string,
  opts: { sessionId?: string } = {},
): Promise<boolean> {
  const threshold = await mergeThresholdOf(repos, opts.sessionId);
  const all = (await repos.memories.list(characterId, troupeId)).filter((r) => r.kind === 'session');
  if (!shouldRebuildEpoch(all.length, threshold)) return false;
  await rebuildEpoch(repos, characterId, troupeId, { ...opts, threshold });
  return true;
}

async function rebuildEpoch(
  repos: Repos,
  characterId: string,
  troupeId: string,
  opts: { sessionId?: string; threshold?: number } = {},
): Promise<void> {
  const threshold = opts.threshold ?? (await mergeThresholdOf(repos, opts.sessionId));
  const all = (await repos.memories.list(characterId, troupeId)).filter((r) => r.kind === 'session');
  const covered = selectRecordsForEpoch(all, threshold);
  if (covered.length === 0) return;
  const latest = all.at(-1)!;
  try {
    const character = await repos.characters.get(characterId);
    const summary = await callSummaryLlmWithRetry(repos, troupeId, [
      { role: 'system', content: EPOCH_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `角色：${character?.name ?? characterId}\n\n逐场摘要（升序，合并为一条）：\n${covered
          .map((r, i) => `${i + 1}. ${r.summary}`)
          .join('\n')}`,
      },
    ]);
    await repos.memories.upsertEpoch({
      characterId,
      troupeId,
      sessionId: latest.sessionId,
      kind: 'epoch',
      coversCount: covered.length,
      summary,
    });
  } catch (err) {
    // epoch 只是读取优化：合并失败不阻塞主流程，旧 epoch/原始记录仍在
    console.error(`[memory] epoch 合并失败（character ${characterId}）：`, err);
  }
}

/** createTokenCounter 的服务端别名（与生成路径同一实现） */
export const memoryTokenCounter = createTokenCounter();
