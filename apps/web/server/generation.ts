// 进程内生成任务（DESIGN §5.6：不依赖外部队列，长驻 Node 进程承载）。
//
// 流程：draft(queued) → transitionDraft(generating) → resolveModel（POST 时已
// 写入 resolved_* 快照，这里直接消费快照）→ ContextAssembler.assemble（§5.2）
// → adapter.generate(onToken) → ~500ms 节流 flush content → 完成置 ready /
// 出错置 failed 并把 OpenAICompatibleError 的 statusCode/message 落到 error。
//
// M2 段落化（§5.7 ②）：finalize（置 ready 前）把生成全文过 parseGenerationOutput
// ——按 台词/动作/心声 切分、打默认可见性、越权代写截断、无标记 fail-closed。
// 流式期间仍写单段临时文本（singleSegment），ready 前的 content 不是终稿，
// GET draft 响应需兼容两种形态（调用方/ UI 以 status 区分）。
import {
  buildOpeningDraftContent,
  createContextAssembler,
  extractGreetings,
  parseGenerationOutput,
  resolveModel,
  transitionDraft,
  type Draft,
  type MessageSegment,
  type Repos,
} from '@kur-river/core';
import { createTokenCounter, getAdapter, OpenAICompatibleError } from '@kur-river/llm';
import type { GenerationParams } from '@kur-river/core';
import { getRepos } from './repos';

/** 流式写回的节流间隔（§5.6：~500ms 批量 flush，避免 token 级写库） */
const FLUSH_INTERVAL_MS = 500;

// 进程内防重入：同一草稿只允许一个生成任务（globalThis 抗 dev 热重载重复模块实例）
const globalForTasks = globalThis as unknown as { __kurRiverGeneration?: Set<string> };
const running = (globalForTasks.__kurRiverGeneration ??= new Set<string>());

/** POST /drafts 与 /regenerate 共用：入队后立即返回，后台跑完整生成流程 */
export function kickGeneration(draftId: string): void {
  if (running.has(draftId)) return;
  running.add(draftId);
  void runGeneration(draftId)
    .catch((err) => console.error(`[generation] 未捕获异常（draft ${draftId}）`, err))
    .finally(() => running.delete(draftId));
}

/** 流式写回的临时形态：单 public 段落包原始文本（finalize 时由契约解析器替换） */
export function singleSegment(text: string): MessageSegment[] {
  return [{ kind: 'speech', text, visibility: 'public' }];
}

// 越权截断标记（§5.7 ② truncated）：drafts 表无此列，且原始文本不落库，
// 无法事后重推——以进程内 Set 承载，GET draft(s) 响应派生 outputTruncated 字段。
// 进程重启后标记丢失（段落本身不受影响），属可接受的提示位降级。
const globalForTruncated = globalThis as unknown as { __kurRiverTruncated?: Set<string> };
const truncatedDrafts = (globalForTruncated.__kurRiverTruncated ??= new Set<string>());

/** GET draft(s) 响应装饰用：该草稿生成时是否发生过越权截断 */
export function isOutputTruncated(draftId: string): boolean {
  return truncatedDrafts.has(draftId);
}

/** finalize：生成全文 → 契约解析 → 终稿段落；越权截断时登记标记 */
export async function finalizeDraftContent(
  repos: Repos,
  draft: Pick<Draft, 'id' | 'sessionId' | 'characterId'>,
  text: string,
): Promise<MessageSegment[]> {
  const speaker = await repos.characters.get(draft.characterId);
  const castIds = await repos.sessionCast.list(draft.sessionId);
  const castNames = (
    await Promise.all(castIds.map((id) => repos.characters.get(id)))
  ).map((c) => c?.name ?? '');
  const parsed = parseGenerationOutput(text, {
    speakerName: speaker?.name ?? '',
    castNames,
  });
  if (parsed.truncated) truncatedDrafts.add(draft.id);
  return parsed.segments;
}

async function runGeneration(draftId: string): Promise<void> {
  const repos = getRepos();
  const draft = await repos.drafts.get(draftId);
  if (!draft || draft.status !== 'queued') return;

  try {
    await transitionDraft(repos, draftId, 'generating');

    // 模型配置快照在草稿入队时已写入（§2.2 Draft）；缺失说明数据异常
    if (!draft.resolvedConnectionId || !draft.resolvedModel) {
      throw new Error('草稿缺少模型配置快照（resolved_connection_id / resolved_model）');
    }
    const connection = await repos.llmConnections.get(draft.resolvedConnectionId);
    if (!connection) throw new Error(`快照中的 LLM 连接不存在：${draft.resolvedConnectionId}`);
    if (!connection.enabled) throw new Error(`LLM 连接已停用：${connection.name}`);

    const assembler = createContextAssembler({ repos, tokenCounter: createTokenCounter() });
    const messages = await assembler.assemble({
      sessionId: draft.sessionId,
      speakerCharacterId: draft.characterId,
      directive: draft.directive ?? undefined,
      triggerMessageId: draft.triggerMessageId ?? undefined,
    });

    const adapter = getAdapter(connection.providerType);
    let streamed = '';
    let lastFlush = 0;
    const result = await adapter.generate({
      connection,
      model: draft.resolvedModel,
      messages,
      params: draft.resolvedParams ?? {},
      onToken: (delta) => {
        streamed += delta;
        const now = Date.now();
        if (now - lastFlush >= FLUSH_INTERVAL_MS) {
          lastFlush = now;
          // 节流 flush：失败不影响主流，下一轮 flush / 最终写回兜底
          void repos.drafts.updateContent(draftId, singleSegment(streamed)).catch(() => {});
        }
      },
    });

    // 以最终全文为准：契约解析成终稿段落（§5.7 ②），再置 ready
    const finalSegments = await finalizeDraftContent(repos, draft, result.text);
    // 系统级取消复查（M3）：生成期间草稿被归档/截断统一 discard 时静默终止，
    // 不覆写 content、不迁状态
    const current = await repos.drafts.get(draftId);
    if (current?.status === 'discarded') return;
    await repos.drafts.updateContent(draftId, finalSegments);
    await transitionDraft(repos, draftId, 'ready');
  } catch (err) {
    // 系统级取消复查（M3）：生成期间被 discard 时静默终止，不再置 failed
    const current = await repos.drafts.get(draftId).catch(() => null);
    if (current?.status === 'discarded') return;
    // OpenAICompatibleError：statusCode + message 一并落 error 字段，供导演排查
    const error =
      err instanceof OpenAICompatibleError
        ? `HTTP ${err.statusCode}：${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    await transitionDraft(repos, draftId, 'failed', { error }).catch((e) => {
      console.error(`[generation] 草稿置 failed 失败（draft ${draftId}）`, e);
    });
  }
}

/** 生成前解析"用哪个连接/模型/参数"并返回草稿快照字段（§5.5 优先级链） */
export async function resolveSnapshot(
  repos: Repos,
  input: {
    sessionId: string;
    characterId: string;
    connectionId?: string;
    model?: string;
    presetId?: string;
  },
): Promise<{ resolvedConnectionId: string; resolvedModel: string; resolvedParams: GenerationParams }> {
  const character = await repos.characters.get(input.characterId);
  if (!character) throw new Error(`发言角色不存在：${input.characterId}`);
  const session = await repos.sessions.get(input.sessionId);
  if (!session) throw new Error(`场次不存在：${input.sessionId}`);
  const troupe = await repos.troupes.get(session.troupeId);
  if (!troupe) throw new Error(`场次所属团队不存在：${session.troupeId}`);

  const resolved = resolveModel({
    request: {
      connectionId: input.connectionId,
      model: input.model,
      presetId: input.presetId,
    },
    character,
    troupe,
    global: await repos.settings.get(),
    connections: await repos.llmConnections.list(),
    presets: await repos.generationPresets.list(),
  });
  return {
    resolvedConnectionId: resolved.connection.id,
    resolvedModel: resolved.model,
    resolvedParams: resolved.params,
  };
}

/**
 * 开场草稿（§5.2.2）：场次尚无任何消息与草稿、且首个在场角色卡带
 * first_mes / alternate_greetings 时，宏替换后造一个 ready 态草稿
 * （模型配置快照字段此时为空——它不经过生成）。
 * 在场次创建（含初始 cast）与首次上场两条路径后调用。
 */
export async function maybeCreateOpeningDraft(
  repos: Repos,
  sessionId: string,
): Promise<Draft | null> {
  const [recent, existing, castIds] = await Promise.all([
    repos.messages.listRecent(sessionId, 1),
    repos.drafts.listBySession(sessionId),
    repos.sessionCast.list(sessionId),
  ]);
  if (recent.length > 0 || existing.length > 0 || castIds.length === 0) return null;

  const first = await repos.characters.get(castIds[0]);
  if (!first || extractGreetings(first.card).length === 0) return null;

  const session = await repos.sessions.get(sessionId);
  const troupe = session ? await repos.troupes.get(session.troupeId) : null;
  const persona = troupe?.defaultPersonaId
    ? await repos.personas.get(troupe.defaultPersonaId)
    : null;

  const content = buildOpeningDraftContent(first.card, {
    char: first.name,
    user: persona?.name ?? 'User',
  });
  const draft = await repos.drafts.create({ sessionId, characterId: first.id, content });
  // 状态机没有 queued → ready 直达边，经 generating 过渡（内容已齐，不跑生成）
  await transitionDraft(repos, draft.id, 'generating');
  return transitionDraft(repos, draft.id, 'ready');
}
