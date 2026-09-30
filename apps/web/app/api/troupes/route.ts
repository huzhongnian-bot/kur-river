// /api/troupes —— 演出团队 CRUD（§2.2 Troupe）；列表按 ?worldId= 过滤
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody } from '@/server/http';
import { isUuid, optEnum, optJson, optString, optUuid, reqString, reqUuid } from '@/server/validate';
import { SKIN_IDS } from '@/lib/skins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const worldId = new URL(req.url).searchParams.get('worldId');
    if (!worldId || !isUuid(worldId)) throw badRequest('查询参数 worldId 必填且为合法 UUID');
    const repos = getRepos();
    if (!(await repos.worlds.get(worldId))) throw notFound(`世界书不存在：${worldId}`);
    return json(await repos.troupes.listByWorld(worldId));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const repos = getRepos();
    const worldId = reqUuid(body, 'worldId');
    if (!(await repos.worlds.get(worldId))) throw notFound(`世界书不存在：${worldId}`);
    const defaultPersonaId = optUuid(body, 'defaultPersonaId');
    if (defaultPersonaId) {
      const persona = await repos.personas.get(defaultPersonaId);
      if (!persona || persona.worldId !== worldId) {
        throw badRequest(`默认化身不存在或不属于本世界：${defaultPersonaId}`);
      }
    }
    const troupe = await repos.troupes.create({
      worldId,
      name: reqString(body, 'name', 200),
      outline: optJson(body, 'outline'),
      toneDirective: optString(body, 'toneDirective'),
      skin: optEnum(body, 'skin', SKIN_IDS),
      defaultPersonaId,
      llmConnectionId: optUuid(body, 'llmConnectionId'),
      model: optString(body, 'model', 200),
      presetId: optUuid(body, 'presetId'),
    });
    return json(troupe, 201);
  } catch (err) {
    return handleError(err);
  }
}
