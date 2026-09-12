// /api/sessions/:id/messages —— GET（seq 分页）+ POST（导演/玩家直接发言，§2.2）
//
// 直接落盘路径的同等约定（§2.2）：落盘前宏替换（"库里不存裸宏"——
// {{char}} → 在场名单首位角色名，{{user}} → 当前化身名），segments 默认
// 构造为单个 public 段落，visibleTo 取当时在场名单快照。
import { and, desc, eq, lt } from 'drizzle-orm';
import { getDb, messages as messagesTable } from '@kur-river/db';
import { substituteMacros, type MacroContext } from '@kur-river/core';
import { getRepos } from '@/server/repos';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { optString, optUuid, pathUuid, reqString } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** GET ?beforeSeq=N&limit=M：按 seq 升序返回 beforeSeq 之前的最近 M 条（导演视图，全段落） */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    if (!(await repos.sessions.get(id))) throw notFound(`场次不存在：${id}`);

    const url = new URL(req.url);
    const beforeSeqRaw = url.searchParams.get('beforeSeq');
    const limitRaw = url.searchParams.get('limit');
    const beforeSeq = beforeSeqRaw === null ? null : Number(beforeSeqRaw);
    if (beforeSeqRaw !== null && (!Number.isInteger(beforeSeq) || (beforeSeq ?? 0) < 1)) {
      throw badRequest(`beforeSeq 必须是正整数：${beforeSeqRaw}`);
    }
    const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw badRequest(`limit 必须是 1..${MAX_LIMIT} 的整数：${limitRaw}`);
    }

    const conds = [eq(messagesTable.sessionId, id)];
    if (beforeSeq !== null) conds.push(lt(messagesTable.seq, beforeSeq));
    const rows = await getDb()
      .select()
      .from(messagesTable)
      .where(and(...conds))
      .orderBy(desc(messagesTable.seq))
      .limit(limit);
    return json(rows.reverse());
  } catch (err) {
    return handleError(err);
  }
}

/**
 * POST 直接发言：{ senderType: 'director' | 'player', text, personaId? }
 * player 消息的 senderId = persona id（须属本世界）；director 无 senderId。
 * 落盘前完成宏替换（§2.2）；单 public 段落；visibleTo = 当时在场名单快照。
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    const session = await repos.sessions.get(id);
    if (!session) throw notFound(`场次不存在：${id}`);
    const troupe = await repos.troupes.get(session.troupeId);
    if (!troupe) throw notFound(`场次所属团队不存在：${session.troupeId}`);

    const body = await readBody(req);
    const senderType = body.senderType;
    if (senderType !== 'director' && senderType !== 'player') {
      throw badRequest("senderType 必须是 director / player（角色发言走草稿确认流）");
    }
    const text = reqString(body, 'text');

    // {{user}} 的来源：player 消息用指定/默认化身；director 消息用团队默认化身
    const personaId = senderType === 'player' ? (optUuid(body, 'personaId') ?? null) : null;
    let userName = 'User';
    // player 消息的 sender_id = 实际使用的 persona id（§6.1），含团队默认化身的情形
    let resolvedPersonaId: string | null = null;
    if (senderType === 'player') {
      const persona = personaId
        ? await repos.personas.get(personaId)
        : troupe.defaultPersonaId
          ? await repos.personas.get(troupe.defaultPersonaId)
          : null;
      if (!persona || persona.worldId !== troupe.worldId) {
        throw badRequest('player 发言需要 personaId 或团队默认化身（且属于本世界）');
      }
      userName = persona.name;
      resolvedPersonaId = persona.id;
    } else if (troupe.defaultPersonaId) {
      const persona = await repos.personas.get(troupe.defaultPersonaId);
      if (persona) userName = persona.name;
    }

    // {{char}} 的来源：直接发言没有发言人，取在场名单首位角色名（§2.2 在场角色名）
    const castIds = await repos.sessionCast.list(id);
    let charName = '角色';
    if (castIds.length > 0) {
      const first = await repos.characters.get(castIds[0]);
      if (first) charName = first.name;
    }

    const macroCtx: MacroContext = { char: charName, user: userName };
    const message = await repos.messages.append({
      sessionId: id,
      senderType,
      senderId: senderType === 'player' ? resolvedPersonaId : null,
      content: [{ kind: 'speech', text: substituteMacros(text, macroCtx), visibility: 'public' }],
      visibleTo: [...castIds],
    });
    return json(message, 201);
  } catch (err) {
    return handleError(err);
  }
}
