// /api/troupes/:id —— 单团队读写删；GET 附带成员与化身名校验后的展示数据
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { optJson, optString, optUuid, pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    const troupe = await repos.troupes.get(id);
    if (!troupe) throw notFound(`团队不存在：${id}`);
    const members = await repos.troupeMembers.list(id);
    return json({ ...troupe, memberCharacterIds: members });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    const troupe = await repos.troupes.get(id);
    if (!troupe) throw notFound(`团队不存在：${id}`);
    const body = await readBody(req);
    if (Object.keys(body).length === 0) throw badRequest('PATCH 请求体为空');
    const defaultPersonaId = optUuid(body, 'defaultPersonaId');
    if (defaultPersonaId) {
      const persona = await repos.personas.get(defaultPersonaId);
      if (!persona || persona.worldId !== troupe.worldId) {
        throw badRequest(`默认化身不存在或不属于本世界：${defaultPersonaId}`);
      }
    }
    const updated = await repos.troupes.update(id, {
      name: optString(body, 'name', 200) ?? undefined,
      outline: 'outline' in body ? optJson(body, 'outline') : undefined,
      toneDirective: optString(body, 'toneDirective'),
      defaultPersonaId,
      llmConnectionId: optUuid(body, 'llmConnectionId'),
      model: optString(body, 'model', 200),
      presetId: optUuid(body, 'presetId'),
    });
    if (!updated) throw notFound(`团队不存在：${id}`);
    return json(updated);
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const ok = await getRepos().troupes.remove(id);
    if (!ok) throw notFound(`团队不存在：${id}`);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
