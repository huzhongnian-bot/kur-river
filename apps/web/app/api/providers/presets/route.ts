// /api/providers/presets —— 采样参数预设 CRUD（§5.5 GenerationPreset）
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, readBody } from '@/server/http';
import { optJson, reqString } from '@/server/validate';
import type { GenerationParams } from '@kur-river/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function reqParams(body: Record<string, unknown>): GenerationParams {
  const params = optJson(body, 'params');
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw badRequest('字段 params 必填且必须是对象（如 {"temperature":0.7}）');
  }
  return params as GenerationParams;
}

export async function GET() {
  try {
    return json(await getRepos().generationPresets.list());
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const preset = await getRepos().generationPresets.create({
      name: reqString(body, 'name', 200),
      params: reqParams(body),
    });
    return json(preset, 201);
  } catch (err) {
    return handleError(err);
  }
}
