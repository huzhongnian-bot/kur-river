// /api/providers/connections/:id —— 单连接读写删。
// PATCH 的 apiKey：undefined 不动；传空字符串表示清空。
import { getRepos } from '@/server/repos';
import { toPublicConnection } from '@/server/providers';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { optBool, optString, pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const connection = await getRepos().llmConnections.get(id);
    if (!connection) throw notFound(`LLM 连接不存在：${id}`);
    return json(toPublicConnection(connection));
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.llmConnections.get(id))) throw notFound(`LLM 连接不存在：${id}`);
    const body = await readBody(req);
    if (Object.keys(body).length === 0) throw badRequest('PATCH 请求体为空');
    const updated = await repos.llmConnections.update(id, {
      name: optString(body, 'name', 200) ?? undefined,
      providerType: optString(body, 'providerType', 100) ?? undefined,
      baseUrl: optString(body, 'baseUrl', 2000) ?? undefined,
      apiKey: optString(body, 'apiKey', 2000) ?? undefined,
      defaultModel: optString(body, 'defaultModel', 200),
      enabled: optBool(body, 'enabled'),
    });
    if (!updated) throw notFound(`LLM 连接不存在：${id}`);
    return json(toPublicConnection(updated));
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const ok = await getRepos().llmConnections.remove(id);
    if (!ok) throw notFound(`LLM 连接不存在：${id}`);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
