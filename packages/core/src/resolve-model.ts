// 模型路由解析（DESIGN §5.5）：纯函数，四级覆盖优先级
// 单次生成指定 > 角色绑定 > 团队绑定 > 全局默认（连接/模型/预设各自独立回退）。

import type { GenerationParams, LlmConnection } from '@kur-river/llm';
import type { AppSettings, Character, GenerationPreset, Troupe } from './types';

export interface ResolveModelInput {
  /** 单次覆盖（§5.1 GenerationRequest 的三个可选字段） */
  request: { connectionId?: string; model?: string; presetId?: string };
  character: Pick<Character, 'llmConnectionId' | 'model'>;
  troupe: Pick<Troupe, 'llmConnectionId' | 'model' | 'presetId'>;
  /** 全局默认（settings 行；无行时传 null/空对象） */
  global?: Pick<
    AppSettings,
    'defaultConnectionId' | 'defaultModel' | 'defaultPresetId'
  > | null;
  connections: LlmConnection[];
  presets: GenerationPreset[];
}

export interface ResolvedLlm {
  connection: LlmConnection;
  model: string;
  params: GenerationParams;
  /** 命中的预设（params 的来源），便于草稿快照追溯 */
  preset: GenerationPreset | null;
}

/**
 * 解析"用哪个连接、哪个模型、哪套参数"（§5.5）。
 * 连接回退链在选定连接后再取连接的 defaultModel 作为模型最后一档。
 * 连接或模型任一无法解析时抛错（生成前必须可解析）。
 */
export function resolveModel(input: ResolveModelInput): ResolvedLlm {
  const { request, character, troupe, global: globalSettings } = input;

  const connectionId =
    request.connectionId ??
    character.llmConnectionId ??
    troupe.llmConnectionId ??
    globalSettings?.defaultConnectionId ??
    null;
  if (!connectionId) {
    throw new Error('无法解析 LLM 连接：四级（单次/角色/团队/全局）均未配置');
  }
  const connection =
    input.connections.find((c) => c.id === connectionId) ?? null;
  if (!connection) throw new Error(`LLM 连接不存在：${connectionId}`);
  if (!connection.enabled) throw new Error(`LLM 连接已停用：${connection.name}`);

  const model =
    request.model ??
    character.model ??
    troupe.model ??
    globalSettings?.defaultModel ??
    connection.defaultModel ??
    null;
  if (!model) {
    throw new Error(
      `无法解析模型：单次/角色/团队/全局/连接默认均未配置（连接 ${connection.name}）`,
    );
  }

  const presetId =
    request.presetId ?? troupe.presetId ?? globalSettings?.defaultPresetId ?? null;
  const preset = presetId
    ? (input.presets.find((p) => p.id === presetId) ?? null)
    : null;
  if (presetId && !preset) throw new Error(`采样参数预设不存在：${presetId}`);

  return { connection, model, params: { ...(preset?.params ?? {}) }, preset };
}
