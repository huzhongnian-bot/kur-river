import { describe, expect, it } from 'vitest';
import {
  buildOpeningDraftContent,
  cardData,
  cardText,
  extractGreetings,
  renderCharacterCard,
} from '../src/card/index';

const v2Card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Alice',
    description: '银发剑士，{{user}} 的护卫',
    personality: '冷静',
    scenario: '边境要塞',
    first_mes: '{{char}} 按剑而立，向 {{user}} 点头。',
    mes_example: '{{char}}: 示例',
    alternate_greetings: ['备选开场一', '备选开场二'],
  },
};

describe('cardData：V2/V3 与扁平 V1 兼容', () => {
  it('解包 V2 data 层', () => {
    expect(cardData(v2Card).name).toBe('Alice');
  });
  it('扁平 V1 字段直接读取', () => {
    expect(cardData({ description: '扁平', first_mes: 'hi' }).description).toBe('扁平');
  });
  it('非对象输入返回空', () => {
    expect(cardData(null)).toEqual({});
  });
});

describe('cardText / renderCharacterCard', () => {
  it('cardText 汇总可扫描字段', () => {
    const text = cardText(v2Card);
    expect(text).toContain('银发剑士');
    expect(text).toContain('冷静');
    expect(text).toContain('边境要塞');
  });

  it('renderCharacterCard 含卡字段；includeSecrets 时才带 secrets（§2.2 隔离）', () => {
    const char = { name: 'Alice', card: v2Card, secrets: { truth: '其实是叛徒' } };
    const withSecrets = renderCharacterCard(char, { includeSecrets: true });
    expect(withSecrets).toContain('# Alice');
    expect(withSecrets).toContain('银发剑士');
    expect(withSecrets).toContain('其实是叛徒');
    const without = renderCharacterCard(char, { includeSecrets: false });
    expect(without).not.toContain('其实是叛徒');
  });
});

describe('开场（§5.2.2）', () => {
  it('extractGreetings：first_mes 在前，alternates 随后', () => {
    const greetings = extractGreetings(v2Card);
    expect(greetings).toHaveLength(3);
    expect(greetings[0]).toContain('按剑而立');
    expect(greetings[2]).toBe('备选开场二');
  });

  it('buildOpeningDraftContent：宏替换后构造单 public 段落', () => {
    const content = buildOpeningDraftContent(v2Card, { char: 'Alice', user: '导演' });
    expect(content).toEqual([
      {
        kind: 'action',
        text: 'Alice 按剑而立，向 导演 点头。',
        visibility: 'public',
      },
    ]);
  });

  it('可选 alternate_greetings；索引越界与无开场都抛错', () => {
    const alt = buildOpeningDraftContent(v2Card, { char: 'A', user: 'U' }, 1);
    expect(alt[0].text).toBe('备选开场一');
    expect(() => buildOpeningDraftContent(v2Card, { char: 'A', user: 'U' }, 99)).toThrow();
    expect(() => buildOpeningDraftContent({}, { char: 'A', user: 'U' })).toThrow();
  });
});
