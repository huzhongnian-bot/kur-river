// token 计数抽象（可插拔，DESIGN §4.2）。
// 当前为估算实现：ASCII ≈ 4 字符/token、CJK ≈ 1 字/token，以字符数作上限兜底。
// 对非 OpenAI 系模型本就只有近似意义，预算截断统一预留 ~10% buffer（§10.3）。
// 后续如需更准可换 js-tokenizers，保持 TokenCounter 接口不变即可。
import type { ChatMessage } from './adapter';

export interface TokenCounter {
  readonly name: string;
  /** 统计单段文本的 token 数；model 用于选择匹配的 tokenizer */
  countText(text: string, model?: string): number;
  /** 统计一组聊天消息的 token 数（含 role 开销） */
  countMessages(messages: ChatMessage[], model?: string): number;
}

// CJK 统一表意文字（基本区 + 扩展 A/B）、假名、谚文、全角与 CJK 标点
const CJK_RE =
  /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af\u{20000}-\u{2a6df}]/gu;

/** ASCII 近似：4 字符 ≈ 1 token */
const CHARS_PER_ASCII_TOKEN = 4;

/** 每条消息的 role/分隔符开销（OpenAI 惯例 ~4 token） */
const MESSAGE_OVERHEAD_TOKENS = 4;

export function createTokenCounter(): TokenCounter {
  return {
    name: `estimate(cjk=1,ascii=1/${CHARS_PER_ASCII_TOKEN})`,
    countText(text: string): number {
      if (!text) return 0;
      const cjk = text.match(CJK_RE)?.length ?? 0;
      const rest = text.replace(CJK_RE, '').length;
      const estimate = Math.ceil(rest / CHARS_PER_ASCII_TOKEN) + cjk;
      // 上限兜底：估算值不超过字符数（真实 tokenizer 极少超过 1 token/字符）
      return Math.min(estimate, text.length);
    },
    countMessages(messages: ChatMessage[]): number {
      return messages.reduce(
        (sum, message) => sum + MESSAGE_OVERHEAD_TOKENS + this.countText(message.content),
        0,
      );
    },
  };
}
