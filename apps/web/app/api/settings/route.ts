// /api/settings —— 全局默认连接/模型/预设读写（§5.5 优先级链最底层）
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, readBody } from '@/server/http';
import { optString, optUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const settings = await getRepos().settings.get();
    return json(
      settings ?? { defaultConnectionId: null, defaultPresetId: null, defaultModel: null },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function PUT(req: Request) {
  try {
    const body = await readBody(req);
    const repos = getRepos();
    const defaultConnectionId = optUuid(body, 'defaultConnectionId');
    const defaultPresetId = optUuid(body, 'defaultPresetId');
    const defaultModel = optString(body, 'defaultModel', 200);
    if (defaultConnectionId) {
      const connection = await repos.llmConnections.get(defaultConnectionId);
      if (!connection) throw badRequest(`默认连接不存在：${defaultConnectionId}`);
    }
    if (defaultPresetId) {
      const preset = await repos.generationPresets.get(defaultPresetId);
      if (!preset) throw badRequest(`默认预设不存在：${defaultPresetId}`);
    }
    const settings = await repos.settings.upsert({
      ...(defaultConnectionId !== undefined ? { defaultConnectionId } : {}),
      ...(defaultPresetId !== undefined ? { defaultPresetId } : {}),
      ...(defaultModel !== undefined ? { defaultModel } : {}),
    });
    return json(settings);
  } catch (err) {
    return handleError(err);
  }
}
