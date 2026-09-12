// 输出契约与解析（DESIGN §5.7 散文风治理）。
// ① DEFAULT_OUTPUT_CONTRACT：注入 system 的契约文本（ContextAssembler ⑥ 第二个
//    system 消息末尾），与 ② 的解析器保持同步——改动任一侧必须检查另一侧。
// ② parseGenerationOutput：afterGenerate 解析拦截器（§4.4 首个内建实现），
//    把 LLM 的散文混合体切成段落并打默认可见性。
//
// 解析器自定边界规则（设计未指定部分，均在此注明并有测试锁定）：
// - 标记不嵌套：span 内部的其他开标记按字面文本处理，只认本 span 的闭标记。
// - 未配对标记：开标记后内容直到文末按该类型成段（内心独白借此 fail-closed——
//   未闭合的 (... 宁可藏成 self_director 也不公开；台词/动作两段可见性相同，
//   仅 kind 不同）。
// - ** 及以上的星号连写（如 **bold**）不算动作标记，按字面文本处理；
//   span 内出现的首个 * 即闭合动作段。
// - 括号开闭可跨半/全角配对：( 或 （ 打开的内心独白，) 或 ） 均可闭合
//   （模型常混用；引号与书名号式「」则严格成对）。
// - 裸文本（无标记包裹的非空片段）按 action/public 成段：契约跟随时裸文本
//   几乎都是叙述/动作。全文无任何契约标记才走 fail-closed 单段 self_director
//   （§5.7：模型完全不理会契约时，未识别内容默认不进全员上下文，交由导演
//   在定密台手动下放；不追求 100% 解析率）。
// - 空输入（空串/纯空白）→ segments: []（无内容可定密，无需降级段）。
// - 段落文本两侧 trim；trim 后为空的段落丢弃。
// - 越权裁剪（同 ST 群聊处理）：逐行扫描，某行以"其他在场角色名 + 冒号
//   （： 或 :，名前允许前导空白、名与冒号间允许空白）"开头即视为代写，
//   从该行起始处截断并置 truncated=true；名字比较不区分大小写。

import type { MessageSegment, SegmentKind, SegmentVisibility } from '../types';

/** §5.7 ① 输出契约（注入 system prompt）。与下方解析器识别的标记一一对应。 */
export const DEFAULT_OUTPUT_CONTRACT = [
  '【输出契约】',
  '你以小说散文体演绎自己的角色，输出时用以下标记区分内容类型：',
  '- 台词：用引号包裹，中文「...」或英文 "..." 均可。',
  '- 动作、神态、环境描写：用 *...* 包裹。',
  '- 内心独白：用圆括号包裹，中文（...）或英文 (...) 均可。',
  '- 只演自己的角色：不要替其他在场角色写台词、动作或心理活动，也不要以 "角色名：" 开头代写他人发言。',
].join('\n');

// ---------------------------------------------------------------------------
// ② afterGenerate 解析拦截器
// ---------------------------------------------------------------------------

export interface ParseGenerationOptions {
  /** 发言角色名（越权检测时从 castNames 中排除自身） */
  speakerName: string;
  /** 在场角色名列表（含本人；除本人外为空时不做越权检测） */
  castNames: string[];
}

export interface ParsedGeneration {
  /** 切分后的段落（默认可见性：speech/action → public，thought → self_director） */
  segments: MessageSegment[];
  /** 检测到为其他在场角色代写台词/主观动作，已从该处截断（§5.7 ②） */
  truncated: boolean;
}

/** 段落默认可见性（§5.7 ②）：speech/action → public，thought → self_director */
export const DEFAULT_SEGMENT_VISIBILITY: Record<SegmentKind, SegmentVisibility> = {
  speech: 'public',
  action: 'public',
  thought: 'self_director',
};

type SpanKind = SegmentKind | 'bare';

interface Span {
  kind: SpanKind;
  text: string;
}

/** 引号开闭对：「」与弯引号 “” 严格成对；直双引号 " 以切换方式自成开闭 */
const QUOTE_OPENERS: Record<string, string> = { '「': '」', '“': '”', '"': '"' };
/** 内心独白闭括号：半/全角通用（见文件头规则） */
const PAREN_CLOSERS = new Set([')', '）']);

/** 把全文切成裸文本/台词/动作/内心独白 span 序列；返回是否见到任何契约标记 */
function splitSpans(text: string): { spans: Span[]; sawMarker: boolean } {
  const spans: Span[] = [];
  let sawMarker = false;
  let mode: { kind: SpanKind; closer: string | null } = { kind: 'bare', closer: null };
  let buffer = '';

  const flush = () => {
    if (buffer.length > 0) spans.push({ kind: mode.kind, text: buffer });
    buffer = '';
  };
  const open = (kind: SegmentKind, closer: string | null) => {
    flush();
    sawMarker = true;
    mode = { kind, closer };
  };
  const close = () => {
    flush();
    mode = { kind: 'bare', closer: null };
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (mode.kind === 'bare') {
      const quoteCloser = QUOTE_OPENERS[ch];
      if (quoteCloser !== undefined) {
        open('speech', quoteCloser);
      } else if (ch === '*') {
        // 星号连写（**bold** 等）不是契约标记，整段按字面吞入
        let j = i;
        while (j < text.length && text[j] === '*') j++;
        if (j - i >= 2) {
          buffer += text.slice(i, j);
          i = j;
          continue;
        }
        open('action', '*');
      } else if (ch === '(' || ch === '（') {
        open('thought', null);
      } else {
        buffer += ch;
      }
    } else if (mode.kind === 'thought') {
      if (PAREN_CLOSERS.has(ch)) close();
      else buffer += ch;
    } else if (ch === mode.closer) {
      close();
    } else {
      buffer += ch;
    }
    i++;
  }
  // 未配对标记：span 内容直到文末按该类型成段（文件头规则）
  flush();
  return { spans, sawMarker };
}

/** 越权代写检测：返回截断位置（代写行的行首偏移），无则 -1 */
function findUsurpationOffset(text: string, otherNames: string[]): number {
  const names = otherNames.map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0);
  if (names.length === 0) return -1;
  let offset = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart().toLowerCase();
    for (const name of names) {
      if (trimmed.startsWith(name)) {
        const rest = trimmed.slice(name.length);
        if (/^\s*[:：]/.test(rest)) return offset;
      }
    }
    offset += line.length + 1; // + '\n'
  }
  return -1;
}

/**
 * §5.7 ②：把生成文本解析成段落数组。
 * 顺序：越权裁剪（行级）→ 按契约标记切分 → 默认可见性 → fail-closed 兜底。
 */
export function parseGenerationOutput(
  text: string,
  options: ParseGenerationOptions,
): ParsedGeneration {
  const others = options.castNames.filter(
    (n) => n.trim().toLowerCase() !== options.speakerName.trim().toLowerCase(),
  );
  const cutAt = findUsurpationOffset(text, others);
  const truncated = cutAt >= 0;
  const kept = truncated ? text.slice(0, cutAt) : text;

  const { spans, sawMarker } = splitSpans(kept);

  // fail-closed（§5.7）：全文无任何契约标记 → 单个 self_director 段落
  if (!sawMarker) {
    const whole = kept.trim();
    return {
      segments:
        whole.length > 0
          ? [{ kind: 'thought', text: whole, visibility: 'self_director' }]
          : [],
      truncated,
    };
  }

  const segments: MessageSegment[] = [];
  for (const span of spans) {
    const trimmedText = span.text.trim();
    if (trimmedText.length === 0) continue; // 空段丢弃（文件头规则）
    const kind: SegmentKind = span.kind === 'bare' ? 'action' : span.kind;
    segments.push({ kind, text: trimmedText, visibility: DEFAULT_SEGMENT_VISIBILITY[kind] });
  }
  return { segments, truncated };
}
