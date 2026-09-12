// ProviderAdapter 接口（DESIGN §4.2）。新增厂商 = 实现此接口并注册（registry.ts）。

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 采样参数（DESIGN §5.5 GenerationPreset.params），允许厂商扩展字段 */
export interface GenerationParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  [key: string]: unknown;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** 一条命名连接 = 一个可用 API 来源（DESIGN §5.5）；apiKey 仅服务端保管 */
export interface LlmConnection {
  id: string;
  name: string;
  /** 决定用哪个 Adapter，如 'openai-compatible' */
  providerType: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  enabled: boolean;
}

export interface GenerateRequest {
  connection: LlmConnection;
  model: string;
  messages: ChatMessage[];
  params: GenerationParams;
  /** 流式回调 */
  onToken?: (delta: string) => void;
  /** 可选中止信号；适配器内部会再叠加默认超时（openai-compatible 为 120s） */
  signal?: AbortSignal;
}

// 本包零依赖、lib 未含 DOM 也无 @types/node，此处为全局 AbortSignal 补一个
// 最小结构声明。与 DOM lib / @types/node 的同名接口是接口合并关系，
// 消费方（apps/web 含 DOM、core 仅 ES2022）编译均不冲突。
declare global {
  interface AbortSignal {
    readonly aborted: boolean;
  }
}

export interface GenerateResult {
  text: string;
  usage?: TokenUsage;
}

export interface ProviderAdapter {
  readonly type: string;
  /** 拉取可用模型列表 */
  listModels(conn: LlmConnection): Promise<string[]>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
