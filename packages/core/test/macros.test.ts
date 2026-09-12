import { describe, expect, it } from 'vitest';
import { substituteMacros } from '../src/card/macros';

const ctx = { char: 'Alice', user: '导演' };

describe('substituteMacros（§5.2 ⑥，M1 支持 {{char}}/{{user}}）', () => {
  it('替换 {{char}} 与 {{user}}', () => {
    expect(substituteMacros('{{char}} 向 {{user}} 问好', ctx)).toBe('Alice 向 导演 问好');
  });

  it('大小写不敏感、允许空白', () => {
    expect(substituteMacros('{{Char}}/{{ CHAR }}/{{ char }}', ctx)).toBe('Alice/Alice/Alice');
    expect(substituteMacros('{{User}}', ctx)).toBe('导演');
  });

  it('多处出现全部替换', () => {
    expect(substituteMacros('{{char}} 打了 {{char}} 自己', ctx)).toBe('Alice 打了 Alice 自己');
  });

  it('未识别的宏原样保留', () => {
    expect(substituteMacros('{{random}} 与 {{char}}', ctx)).toBe('{{random}} 与 Alice');
  });

  it('无宏文本原样返回', () => {
    expect(substituteMacros('没有宏', ctx)).toBe('没有宏');
  });
});
