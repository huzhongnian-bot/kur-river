// openai-compatible 适配器契约测试（DESIGN §9：mock fetch，不起真服务）
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmConnection } from '../src/adapter';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_ERROR_BODY_CHARS,
  OpenAICompatibleError,
  openAICompatibleAdapter,
} from '../src/openai-compatible/adapter';
import { getAdapter, listAdapterTypes } from '../src/registry';

const conn: LlmConnection = {
  id: 'c1',
  name: 'test',
  providerType: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'sk-test',
  enabled: true,
};

function stubFetch(impl: (url: string, init?: any) => Promise<any>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textErrorResponse(body: string, status: number) {
  return {
    ok: false,
    status,
    body: null,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => body,
  };
}

/** 把字符串块按真实 ReadableStream 喂给适配器，模拟任意边界的网络分块 */
function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body: stream,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => chunks.join(''),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registry', () => {
  it("注册 'openai-compatible'，for 查找可用", () => {
    expect(getAdapter('openai-compatible')).toBe(openAICompatibleAdapter);
    expect(listAdapterTypes()).toContain('openai-compatible');
  });

  it('未注册的 providerType 抛错', () => {
    expect(() => getAdapter('claude')).toThrow(/未注册/);
  });
});

describe('listModels', () => {
  it('规范化 baseUrl 尾部斜杠，带 Bearer，解析 data[].id', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'deepseek-chat' }, { name: 'no-id' }] }),
    );
    const models = await openAICompatibleAdapter.listModels(conn);
    expect(models).toEqual(['gpt-4o', 'deepseek-chat']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/models');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
  });

  it('非 2xx 抛 OpenAICompatibleError，带 statusCode 与截断正文', async () => {
    stubFetch(async () => textErrorResponse('invalid api key', 401));
    const err = await openAICompatibleAdapter.listModels(conn).catch((e) => e);
    expect(err).toBeInstanceOf(OpenAICompatibleError);
    expect(err.statusCode).toBe(401);
    expect(err.message).toContain('401');
    expect(err.message).toContain('invalid api key');
  });

  it('响应非标准格式（data 非数组 / 无 data）时容错返回空数组', async () => {
    stubFetch(async () => jsonResponse({ data: { object: 'list' } }));
    expect(await openAICompatibleAdapter.listModels(conn)).toEqual([]);
    stubFetch(async () => jsonResponse({}));
    expect(await openAICompatibleAdapter.listModels(conn)).toEqual([]);
    stubFetch(async () => jsonResponse(['not-an-object']));
    expect(await openAICompatibleAdapter.listModels(conn)).toEqual([]);
  });
});

describe('generate', () => {
  it('跨块残缺行拼接解析，onToken 顺序与全文一致，捕获 usage，[DONE] 收尾', async () => {
    stubFetch(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你',
        '好"}}]}\n\nda',
        'ta: {"choices":[{"delta":{"content":"吗"}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n' +
          'data: [DONE]\n\n',
      ]),
    );
    const tokens: string[] = [];
    const result = await openAICompatibleAdapter.generate({
      connection: conn,
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      params: {},
      onToken: (d) => tokens.push(d),
    });
    expect(tokens).toEqual(['你好', '吗']);
    expect(result.text).toBe('你好吗');
    expect(result.text).toBe(tokens.join(''));
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });
  });

  it('末行无换行也能收尾；无 usage 字段时 usage 为 undefined', async () => {
    stubFetch(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"尾"}}]}\n\ndata: [DONE]',
      ]),
    );
    const result = await openAICompatibleAdapter.generate({
      connection: conn,
      model: 'm',
      messages: [],
      params: {},
    });
    expect(result.text).toBe('尾');
    expect(result.usage).toBeUndefined();
  });

  it('忽略非 data 行（注释/空行）', async () => {
    stubFetch(async () =>
      sseResponse([
        ': keep-alive\n\nevent: message\n\ndata: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n',
      ]),
    );
    const result = await openAICompatibleAdapter.generate({
      connection: conn,
      model: 'm',
      messages: [],
      params: {},
    });
    expect(result.text).toBe('a');
  });

  it('非 2xx：错误带 statusCode，超长正文截断到 500 字符', async () => {
    const longBody = 'E'.repeat(600);
    stubFetch(async () => textErrorResponse(longBody, 500));
    const err = await openAICompatibleAdapter
      .generate({ connection: conn, model: 'm', messages: [], params: {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OpenAICompatibleError);
    expect(err.statusCode).toBe(500);
    expect(err.message).not.toContain(longBody);
    expect(err.message).toContain('E'.repeat(MAX_ERROR_BODY_CHARS));
    expect(err.responseBody.length).toBe(MAX_ERROR_BODY_CHARS + 1); // 500 + 省略号
  });

  it('参数映射：camelCase→snake_case，undefined 不上送，扩展字段透传，保留字段不可覆盖', async () => {
    const fetchMock = stubFetch(async () => sseResponse(['data: [DONE]\n\n']));
    await openAICompatibleAdapter.generate({
      connection: conn,
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 's' }],
      params: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 512,
        frequencyPenalty: 0.1,
        presencePenalty: undefined,
        stop: ['##'],
        model: 'evil-override',
        stream: false,
      },
      signal: undefined,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.signal).toBeDefined();
    expect(typeof init.signal.aborted).toBe('boolean');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 's' }],
      stream: true,
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 512,
      frequency_penalty: 0.1,
      stop: ['##'],
    });
    expect(body).not.toHaveProperty('presence_penalty');
    expect(body).not.toHaveProperty('topP');
    expect(body).not.toHaveProperty('maxTokens');
  });

  it('调用方 signal 与超时信号合并：调用方已 abort 时合并信号也 aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = stubFetch(async () => sseResponse(['data: [DONE]\n\n']));
    await openAICompatibleAdapter.generate({
      connection: conn,
      model: 'm',
      messages: [],
      params: {},
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('SSE 错误帧（HTTP 200 流内 {"error":...}）映射为带状态码的错误，已收 token 不返回', async () => {
    stubFetch(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"半"}}]}\n\n' +
          'data: {"error":{"message":"rate limit exceeded","type":"rate_limit_error","code":429}}\n\n',
      ]),
    );
    const tokens: string[] = [];
    const err = await openAICompatibleAdapter
      .generate({
        connection: conn,
        model: 'm',
        messages: [],
        params: {},
        onToken: (d) => tokens.push(d),
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OpenAICompatibleError);
    expect(err.statusCode).toBe(429);
    expect(err.message).toContain('rate limit exceeded');
    // 错误帧前已流式回调的 token 属于调用方已见内容，结果整体失败
    expect(tokens).toEqual(['半']);
  });

  it('SSE 错误帧 code 非数字时以 200 兜底状态码', async () => {
    stubFetch(async () =>
      sseResponse(['data: {"error":{"message":"bad request","code":"invalid"}}\n\n']),
    );
    const err = await openAICompatibleAdapter
      .generate({ connection: conn, model: 'm', messages: [], params: {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OpenAICompatibleError);
    expect(err.statusCode).toBe(200);
  });

  it('默认 120s 超时：导出 DEFAULT_TIMEOUT_MS = 120_000', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
  });
});
