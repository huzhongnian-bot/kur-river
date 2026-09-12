// /api/providers/connections —— LLM 连接 CRUD（§5.5 LlmConnection）
import { getRepos } from '@/server/repos';
import { toPublicConnection } from '@/server/providers';
import { handleError, json, readBody } from '@/server/http';
import { optBool, optString, reqString } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const list = await getRepos().llmConnections.list();
    return json(list.map(toPublicConnection));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const connection = await getRepos().llmConnections.create({
      name: reqString(body, 'name', 200),
      providerType: optString(body, 'providerType', 100) ?? 'openai-compatible',
      baseUrl: reqString(body, 'baseUrl', 2000),
      apiKey: optString(body, 'apiKey', 2000) ?? '',
      defaultModel: optString(body, 'defaultModel', 200),
      enabled: optBool(body, 'enabled'),
    });
    return json(toPublicConnection(connection), 201);
  } catch (err) {
    return handleError(err);
  }
}
