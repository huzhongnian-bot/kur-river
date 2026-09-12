// /api/worlds —— 世界书 CRUD（DESIGN §7.1）
import { getRepos } from '@/server/repos';
import { handleError, json, readBody } from '@/server/http';
import { optJson, reqString } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return json(await getRepos().worlds.list());
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const world = await getRepos().worlds.create({
      title: reqString(body, 'title', 200),
      premise: optJson(body, 'premise'),
    });
    return json(world, 201);
  } catch (err) {
    return handleError(err);
  }
}
