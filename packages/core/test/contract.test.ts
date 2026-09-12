// 输出契约解析器测试矩阵（§5.7 ②）：切分 / 默认可见性 / 中英标记 /
// 越权裁剪 / 不配对 / 嵌套 / fail-closed / 空输入。
import { describe, expect, it } from 'vitest';
import { parseGenerationOutput } from '../src/contract/index';
import type { MessageSegment } from '../src/types';

const OPTS = { speakerName: 'Alice', castNames: ['Alice', 'Bob', 'Carol'] };
const parse = (text: string) => parseGenerationOutput(text, OPTS);

describe('parseGenerationOutput · 多段切分与默认可见性', () => {
  it('台词/动作/内心独白交替切分，保序、trim、打默认可见性', () => {
    const { segments, truncated } = parse('「站住。」 *她拔剑上前。* (不能让他过去。) "再来！"');
    expect(truncated).toBe(false);
    expect(segments).toEqual<MessageSegment[]>([
      { kind: 'speech', text: '站住。', visibility: 'public' },
      { kind: 'action', text: '她拔剑上前。', visibility: 'public' },
      { kind: 'thought', text: '不能让他过去。', visibility: 'self_director' },
      { kind: 'speech', text: '再来！', visibility: 'public' },
    ]);
  });

  it('裸文本（无标记片段）按 action/public 成段', () => {
    const { segments } = parse('雨下得更大了。「进来吧。」她侧身让开门。');
    expect(segments).toEqual<MessageSegment[]>([
      { kind: 'action', text: '雨下得更大了。', visibility: 'public' },
      { kind: 'speech', text: '进来吧。', visibility: 'public' },
      { kind: 'action', text: '她侧身让开门。', visibility: 'public' },
    ]);
  });

  it('空段（「」、()  trim 后为空）丢弃', () => {
    const { segments } = parse('「」 *挥剑* ()');
    expect(segments).toEqual([{ kind: 'action', text: '挥剑', visibility: 'public' }]);
  });
});

describe('parseGenerationOutput · 中英标记识别', () => {
  it('中「」英 "" 弯引号 “” 均识别为台词', () => {
    const { segments } = parse('「甲」 "乙" “丙”');
    expect(segments.map((s) => [s.kind, s.text])).toEqual([
      ['speech', '甲'],
      ['speech', '乙'],
      ['speech', '丙'],
    ]);
  });

  it('中英括号均识别为内心独白；半全角可交叉闭合', () => {
    const { segments } = parse('(英文心声) （中文心声） （交叉闭合)');
    expect(segments.map((s) => [s.kind, s.text])).toEqual([
      ['thought', '英文心声'],
      ['thought', '中文心声'],
      ['thought', '交叉闭合'],
    ]);
    expect(segments.every((s) => s.visibility === 'self_director')).toBe(true);
  });

  it('** 连写（如 **bold**）不是动作标记，按字面文本处理', () => {
    // **bold** 不构成标记 → 全文无契约标记 → fail-closed 单段
    const noMarker = parse('这是 **强调** 的叙述。');
    expect(noMarker.segments).toEqual([
      { kind: 'thought', text: '这是 **强调** 的叙述。', visibility: 'self_director' },
    ]);
    // 与真标记混排时 ** 留在裸文本里
    const mixed = parse('**强调** *真动作*');
    expect(mixed.segments).toEqual<MessageSegment[]>([
      { kind: 'action', text: '**强调**', visibility: 'public' },
      { kind: 'action', text: '真动作', visibility: 'public' },
    ]);
  });
});

describe('parseGenerationOutput · 越权裁剪', () => {
  it('他人角色名 + 中/英冒号起头 → 从该行截断并置 truncated', () => {
    const r1 = parse('「我的台词。」\nBob：这其实是 Alice 的话。\n「后面的也被裁掉」');
    expect(r1.truncated).toBe(true);
    expect(r1.segments).toEqual([{ kind: 'speech', text: '我的台词。', visibility: 'public' }]);

    const r2 = parse('*动作。*\nCarol: "代写台词"');
    expect(r2.truncated).toBe(true);
    expect(r2.segments).toEqual([{ kind: 'action', text: '动作。', visibility: 'public' }]);
  });

  it('名字前允许前导空白、名与冒号间允许空白；大小写不敏感', () => {
    const r = parse('「好。」\n  bob : 代写');
    expect(r.truncated).toBe(true);
    expect(r.segments).toEqual([{ kind: 'speech', text: '好。', visibility: 'public' }]);
  });

  it('本人名字起头不裁剪；名字是他人前缀但没有冒号不裁剪', () => {
    const self = parse('Alice：「自报家门式台词」');
    expect(self.truncated).toBe(false);

    const notPrefix = parseGenerationOutput('「走。」\nBobby 走进来。', {
      speakerName: 'Alice',
      castNames: ['Alice', 'Bob'],
    });
    expect(notPrefix.truncated).toBe(false);
  });

  it('首行即代写 → 截断后无内容，segments 为空', () => {
    const r = parse('Bob：全是代写。');
    expect(r.truncated).toBe(true);
    expect(r.segments).toEqual([]);
  });

  it('行中间的 "名字：" 不触发（只认行首）', () => {
    const r = parse('「Bob：你说什么？」她复述着。');
    expect(r.truncated).toBe(false);
    expect(r.segments[0]).toEqual({
      kind: 'speech',
      text: 'Bob：你说什么？',
      visibility: 'public',
    });
  });
});

describe('parseGenerationOutput · 不配对与嵌套（自定规则，见模块注释）', () => {
  it('未闭合的内心独白延伸到文末，按 thought/self_director 成段（fail-closed）', () => {
    const { segments } = parse('「台词」 (心声没收尾，后面全是心声 "引号也算字面');
    expect(segments).toEqual<MessageSegment[]>([
      { kind: 'speech', text: '台词', visibility: 'public' },
      {
        kind: 'thought',
        text: '心声没收尾，后面全是心声 "引号也算字面',
        visibility: 'self_director',
      },
    ]);
  });

  it('未闭合的引号/星号延伸到文末按各自类型成段', () => {
    expect(parse('「没闭合的台词').segments).toEqual([
      { kind: 'speech', text: '没闭合的台词', visibility: 'public' },
    ]);
    expect(parse('*没闭合的动作').segments).toEqual([
      { kind: 'action', text: '没闭合的动作', visibility: 'public' },
    ]);
  });

  it('标记不嵌套：span 内的其他开标记按字面文本', () => {
    const { segments } = parse('「台词里有 *星号* 和 (括号)」 *动作*');
    expect(segments).toEqual<MessageSegment[]>([
      { kind: 'speech', text: '台词里有 *星号* 和 (括号)', visibility: 'public' },
      { kind: 'action', text: '动作', visibility: 'public' },
    ]);
  });
});

describe('parseGenerationOutput · fail-closed 与空输入', () => {
  it('全文无任何契约标记 → 单个 self_director 段落（§5.7 不追求 100% 解析率）', () => {
    const { segments, truncated } = parse('她什么也没说，只是看着窗外的雨。');
    expect(truncated).toBe(false);
    expect(segments).toEqual([
      {
        kind: 'thought',
        text: '她什么也没说，只是看着窗外的雨。',
        visibility: 'self_director',
      },
    ]);
  });

  it('空串 / 纯空白 → segments 为空', () => {
    expect(parse('').segments).toEqual([]);
    expect(parse('   \n  ').segments).toEqual([]);
  });

  it('castNames 仅本人或为空时不做越权检测', () => {
    const r = parseGenerationOutput('Bob：不裁，因为不在场', {
      speakerName: 'Alice',
      castNames: ['Alice'],
    });
    expect(r.truncated).toBe(false);
    expect(r.segments.length).toBeGreaterThan(0);
  });
});
