// /api/sessions/:id/cast/:characterId —— 下场
import { getRepos } from '@/server/repos';
import { handleError, json, notFound, type RouteCtx } from '@/server/http';
import { pathUuid } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string; characterId: string }>;

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id, characterId } = await ctx.params;
    pathUuid(id);
    pathUuid(characterId, 'characterId');
    const ok = await getRepos().sessionCast.remove(id, characterId);
    if (!ok) throw notFound(`角色不在在场名单中：${characterId}`);
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
