// OpenAI 兼容协议适配器（DESIGN §4.2 首发实现）：覆盖 OpenAI / DeepSeek /
// OpenRouter / LM Studio / vLLM 等一切实现 {baseUrl}/models 与
// {baseUrl}/chat/completions 的服务。运行时用 Node 26 内建 fetch，零依赖。
//
// 已知边界（与设计一致，刻意不做）：
// - 服务端 4xx 明确不支持 stream / stream_options 时，抛带状态码的错误，不做自动降级；
// - 网络错误（fetch reject）原样上抛，不包装、不重试。

import type {
  ChatMessage,
  GenerateRequest,
  GenerateResult,
  GenerationParams,
  LlmConnection,
  ProviderAdapter,
  TokenUsage,
} from '../adapter';

/** 默认请求超时：120s（AbortSignal.timeout 实现） */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** 错误信息中响应正文的最大长度 */
export const MAX_ERROR_BODY_CHARS = 500;

/** HTTP 非 2xx 时抛出：message 含截断后的响应正文，statusCode 供上层分流 */
export class OpenAICompatibleError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(statusCode: number, responseBody: string, action: string) {
    super(`openai-compatible ${action} 失败：HTTP ${statusCode} — ${responseBody}`);
    this.name = 'OpenAICompatibleError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

// --- Node 内建全局的最小结构类型 ---
// 包零依赖、lib 未含 DOM，故对 fetch/TextDecoder 只用 globalThis 取一次并做
// 结构化约束；不 declare 任何全局变量，避免与 DOM lib / @types/node 冲突。

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
    };
  } | null;
  json(): Promise<unknown>;
  text(): Promise<unknown>;
}

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

const runtime = globalThis as unknown as {
  fetch(url: string, init?: FetchInit): Promise<FetchResponse>;
  AbortSignal: {
    timeout(milliseconds: number): AbortSignal;
    any(signals: AbortSignal[]): AbortSignal;
  };
  TextDecoder: new () => {
    decode(input?: Uint8Array, options?: { stream?: boolean }): string;
  };
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function resolveSignal(userSignal?: AbortSignal): AbortSignal {
  const timeout = runtime.AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  return userSignal ? runtime.AbortSignal.any([userSignal, timeout]) : timeout;
}

async function readErrorBody(res: FetchResponse): Promise<string> {
  try {
    const text = String(await res.text());
    return text.length > MAX_ERROR_BODY_CHARS
      ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}…`
      : text;
  } catch {
    return '(无法读取响应正文)';
  }
}

/** camelCase 采样参数 → OpenAI wire 字段；undefined 不上送（§5.5 GenerationPreset.params） */
const PARAM_MAP = {
  temperature: 'temperature',
  topP: 'top_p',
  maxTokens: 'max_tokens',
  frequencyPenalty: 'frequency_penalty',
  presencePenalty: 'presence_penalty',
} as const;

/** 不允许被 params 扩展字段覆盖的保留键 */
const RESERVED_KEYS = new Set(['model', 'messages', 'stream', 'stream_options']);

function buildRequestBody(
  model: string,
  messages: ChatMessage[],
  params: GenerationParams,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    // 要求服务端在末块回传 usage；不支持该字段的服务按 4xx 报错处理（不降级）
    stream_options: { include_usage: true },
  };
  for (const [camel, wire] of Object.entries(PARAM_MAP)) {
    const value = params[camel as keyof typeof PARAM_MAP];
    if (value !== undefined) body[wire] = value;
  }
  // 厂商扩展字段透传（GenerationParams 允许 [key: string]: unknown）
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || key in PARAM_MAP || RESERVED_KEYS.has(key)) continue;
    body[key] = value;
  }
  return body;
}

async function listModels(conn: LlmConnection): Promise<string[]> {
  const res = await runtime.fetch(`${normalizeBaseUrl(conn.baseUrl)}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${conn.apiKey}` },
    signal: resolveSignal(),
  });
  if (!res.ok) {
    throw new OpenAICompatibleError(res.status, await readErrorBody(res), 'listModels');
  }
  const json = (await res.json()) as { data?: unknown };
  // 响应非标准格式（无 data 数组）时容错返回空数组
  if (!Array.isArray(json.data)) return [];
  return json.data
    .map((entry: { id?: unknown }) => entry?.id)
    .filter((id): id is string => typeof id === 'string');
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  /** SSE 错误帧（HTTP 200 但流内报错）：{"error": {...}} */
  error?: {
    message?: string;
    type?: string;
    code?: number | string | null;
  };
}

async function generate(req: GenerateRequest): Promise<GenerateResult> {
  const { connection, model, messages, params, onToken, signal } = req;
  const res = await runtime.fetch(`${normalizeBaseUrl(connection.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${connection.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(buildRequestBody(model, messages, params)),
    signal: resolveSignal(signal),
  });
  if (!res.ok) {
    throw new OpenAICompatibleError(res.status, await readErrorBody(res), 'generate');
  }
  if (!res.body) {
    throw new Error('openai-compatible generate 失败：响应缺少 body（期望 SSE 流）');
  }

  const reader = res.body.getReader();
  const decoder = new runtime.TextDecoder();
  let buffer = '';
  let text = '';
  let usage: TokenUsage | undefined;

  /** 处理一条完整 SSE 行；返回 true 表示收到 [DONE] */
  const handleLine = (line: string): boolean => {
    if (!line.startsWith('data:')) return false; // 空行 / 注释(:) / event: / id: 等一律忽略
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return true;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      throw new Error(`openai-compatible：无法解析 SSE 数据行：${payload.slice(0, 200)}`);
    }
    // SSE 错误帧：映射为带状态码的错误（code 非数字时以流上下文 200 兜底）
    if (chunk.error) {
      const statusCode =
        typeof chunk.error.code === 'number' ? chunk.error.code : 200;
      throw new OpenAICompatibleError(
        statusCode,
        chunk.error.message ?? payload.slice(0, MAX_ERROR_BODY_CHARS),
        'generate（SSE 错误帧）',
      );
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      text += delta;
      onToken?.(delta);
    }
    // usage 一般在末块（include_usage）出现，出现即捕获
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      };
    }
    return false;
  };

  let sawDone = false;
  try {
    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line && handleLine(line)) {
          sawDone = true;
          break;
        }
      }
    }
    // 流结束但缓冲区还有未以 \n 结尾的残余行（部分服务末尾不带换行）
    buffer += decoder.decode();
    if (!sawDone) {
      for (const raw of buffer.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line && handleLine(line)) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return { text, usage };
}

export const openAICompatibleAdapter: ProviderAdapter = {
  type: 'openai-compatible',
  listModels,
  generate,
};
