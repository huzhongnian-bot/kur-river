// 领域内核：纯 TypeScript，零框架/运行时依赖（DESIGN §4.1、§4.2）
export * from './types';
export * from './lorebook/index';
export * from './context/index';
export * from './contract/index';
export * from './visibility/index';
export * from './scheduling/index';
export * from './memory/index';
export * from './card/index';
export * from './events/index';
export * from './draft/index';
export * from './resolve-model';
export * from './token-counter';
export * from './repos/index';
export { createInMemoryRepos } from './repos/in-memory';

// core 消费方（db / web）需要的 llm 侧类型，经 core 转发以免四处引包
export type {
  ChatMessage,
  GenerationParams,
  LlmConnection,
  TokenCounter,
} from '@kur-river/llm';
