// ST 宏替换（DESIGN §5.2 ⑥）。M1 只支持 {{char}} 与 {{user}}，其余 ST 宏按需扩展。
//
// 全局不变量："库里不存裸宏"（§2.2）——宏替换只发生在落盘前
// （草稿确认/直接发言/开场草稿）与当次组装的 system 层和 directive；
// 历史消息读回后不再替换，否则 {{char}} 会被错绑到当前发言角色。

export interface MacroContext {
  /** 发言角色名（{{char}} 的替换来源） */
  char: string;
  /** 当前化身名（{{user}} 的替换来源） */
  user: string;
}

/** 大小写不敏感、允许花括号内空白；未识别的宏原样保留 */
export function substituteMacros(text: string, ctx: MacroContext): string {
  return text
    .replace(/\{\{\s*char\s*\}\}/gi, ctx.char)
    .replace(/\{\{\s*user\s*\}\}/gi, ctx.user);
}
