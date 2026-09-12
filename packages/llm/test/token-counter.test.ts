// token-counter 估算器测试：量级、单调性、消息开销
import { describe, expect, it } from 'vitest';
import { createTokenCounter } from '../src/token-counter';

const counter = createTokenCounter();

describe('token-counter', () => {
  it('空串为 0', () => {
    expect(counter.countText('')).toBe(0);
  });

  it('ASCII ≈ 字符数 / 4', () => {
    expect(counter.countText('a'.repeat(400))).toBe(100);
    expect(counter.countText('a'.repeat(401))).toBe(101);
  });

  it('CJK ≈ 1 token / 字', () => {
    expect(counter.countText('汉'.repeat(100))).toBe(100);
    expect(counter.countText('你好世界')).toBe(4);
  });

  it('中英文混合：介于 CJK 字数与总字符数之间', () => {
    const text = 'hello，世界！这是一段 mixed 文本 with some English words.';
    const n = counter.countText(text);
    expect(n).toBeGreaterThan(10); // 至少覆盖 CJK 字数
    expect(n).toBeLessThanOrEqual(text.length); // 上限兜底
  });

  it('单调性：文本变长，估算不减少', () => {
    const base = '导演说：action！然后角色开始表演，speaking some English lines too。';
    let prev = 0;
    for (let i = 1; i <= base.length; i++) {
      const n = counter.countText(base.slice(0, i));
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('countMessages = 内容估算 + 每条消息固定开销', () => {
    const messages = [
      { role: 'system' as const, content: '你是旁白。' },
      { role: 'user' as const, content: 'hello world' },
    ];
    const contentSum = messages.reduce((s, m) => s + counter.countText(m.content), 0);
    expect(counter.countMessages(messages)).toBe(contentSum + 2 * 4);
    expect(counter.countMessages([])).toBe(0);
  });
});
