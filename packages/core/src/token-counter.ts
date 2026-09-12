// token 估算器的唯一实现已收敛到 @kur-river/llm 的 createTokenCounter
// （ASCII ≈ 4 字符/token、CJK ≈ 1 字/token，预算截断预留 ~10% buffer，§10.3）。
// 此处复导出以保持 core 既有调用点与公开 API 不变（P2 收敛项，原为重复实现）。
// 后续换精确 tokenizer（js-tokenizers）时只改 llm 一处。

export { createTokenCounter as createHeuristicTokenCounter } from '@kur-river/llm';
