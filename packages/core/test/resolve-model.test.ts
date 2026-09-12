import { describe, expect, it } from 'vitest';
import { resolveModel, type ResolveModelInput } from '../src/resolve-model';
import type { LlmConnection } from '@kur-river/llm';
import type { GenerationPreset } from '../src/types';

const connA: LlmConnection = {
  id: 'conn-a', name: 'A', providerType: 'openai-compatible',
  baseUrl: 'https://a', apiKey: 'k', defaultModel: 'a-default', enabled: true,
};
const connB: LlmConnection = {
  id: 'conn-b', name: 'B', providerType: 'openai-compatible',
  baseUrl: 'https://b', apiKey: 'k', defaultModel: 'b-default', enabled: true,
};
const presetStable: GenerationPreset = {
  id: 'preset-stable', name: '稳定叙事', params: { temperature: 0.7, topP: 0.9 },
};
const presetWild: GenerationPreset = {
  id: 'preset-wild', name: '高发散', params: { temperature: 1.3 },
};

function input(partial: Partial<ResolveModelInput> = {}): ResolveModelInput {
  return {
    request: {},
    character: { llmConnectionId: null, model: null },
    troupe: { llmConnectionId: null, model: null, presetId: null },
    global: null,
    connections: [connA, connB],
    presets: [presetStable, presetWild],
    ...partial,
  };
}

describe('resolveModel 四级回退链（§5.5：单次 > 角色 > 团队 > 全局）', () => {
  it('只有全局默认时落到全局；模型落到全局默认模型', () => {
    const r = resolveModel(input({
      global: { defaultConnectionId: 'conn-a', defaultModel: 'global-model', defaultPresetId: 'preset-stable' },
    }));
    expect(r.connection.id).toBe('conn-a');
    expect(r.model).toBe('global-model');
    expect(r.params).toEqual(presetStable.params);
    expect(r.preset?.id).toBe('preset-stable');
  });

  it('全局无默认模型时落到连接的 defaultModel', () => {
    const r = resolveModel(input({
      global: { defaultConnectionId: 'conn-b', defaultModel: null, defaultPresetId: null },
    }));
    expect(r.model).toBe('b-default');
    expect(r.preset).toBeNull();
    expect(r.params).toEqual({});
  });

  it('团队绑定盖过全局', () => {
    const r = resolveModel(input({
      troupe: { llmConnectionId: 'conn-b', model: 'troupe-model', presetId: 'preset-wild' },
      global: { defaultConnectionId: 'conn-a', defaultModel: 'global-model', defaultPresetId: 'preset-stable' },
    }));
    expect(r.connection.id).toBe('conn-b');
    expect(r.model).toBe('troupe-model');
    expect(r.preset?.id).toBe('preset-wild');
  });

  it('角色绑定盖过团队（连接与模型各自独立回退）', () => {
    const r = resolveModel(input({
      character: { llmConnectionId: 'conn-a', model: 'char-model' },
      troupe: { llmConnectionId: 'conn-b', model: 'troupe-model', presetId: 'preset-wild' },
    }));
    expect(r.connection.id).toBe('conn-a');
    expect(r.model).toBe('char-model');
    expect(r.preset?.id).toBe('preset-wild'); // 角色无 preset 字段，仍取团队
  });

  it('单次指定盖过一切', () => {
    const r = resolveModel(input({
      request: { connectionId: 'conn-b', model: 'once-model', presetId: 'preset-stable' },
      character: { llmConnectionId: 'conn-a', model: 'char-model' },
      troupe: { llmConnectionId: 'conn-a', model: 'troupe-model', presetId: 'preset-wild' },
      global: { defaultConnectionId: 'conn-a', defaultModel: 'g', defaultPresetId: 'preset-wild' },
    }));
    expect(r.connection.id).toBe('conn-b');
    expect(r.model).toBe('once-model');
    expect(r.preset?.id).toBe('preset-stable');
  });

  it('params 为预设参数的拷贝（改返回值不污染预设）', () => {
    const r = resolveModel(input({
      request: { connectionId: 'conn-a', presetId: 'preset-stable' },
    }));
    r.params.temperature = 99;
    expect(presetStable.params.temperature).toBe(0.7);
  });

  it('错误路径：无连接 / 连接不存在 / 连接停用 / 无模型 / 预设不存在', () => {
    expect(() => resolveModel(input())).toThrow('无法解析 LLM 连接');
    expect(() => resolveModel(input({ request: { connectionId: 'ghost' } }))).toThrow(
      'LLM 连接不存在',
    );
    const disabled = { ...connA, enabled: false };
    expect(() =>
      resolveModel(input({ request: { connectionId: 'conn-a' }, connections: [disabled] })),
    ).toThrow('已停用');
    const noDefault = { ...connA, defaultModel: undefined };
    expect(() =>
      resolveModel(input({ request: { connectionId: 'conn-a' }, connections: [noDefault] })),
    ).toThrow('无法解析模型');
    expect(() =>
      resolveModel(input({ request: { connectionId: 'conn-a', presetId: 'ghost' } })),
    ).toThrow('采样参数预设不存在');
  });
});
