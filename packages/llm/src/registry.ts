// providerType → Adapter 注册表（DESIGN §4.2）。
import type { ProviderAdapter } from './adapter';
import { openAICompatibleAdapter } from './openai-compatible/adapter';

const adapters = new Map<string, ProviderAdapter>();

// 首发实现：openai-compatible（§5.5 LlmConnection.providerType），
// 覆盖 OpenAI / DeepSeek / OpenRouter / LM Studio / 各类本地推理。
registerAdapter(openAICompatibleAdapter);

export function registerAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.type, adapter);
}

export function getAdapter(providerType: string): ProviderAdapter {
  const adapter = adapters.get(providerType);
  if (!adapter) {
    throw new Error(`未注册的 LLM providerType: ${providerType}`);
  }
  return adapter;
}

export function hasAdapter(providerType: string): boolean {
  return adapters.has(providerType);
}

export function listAdapterTypes(): string[] {
  return [...adapters.keys()];
}
