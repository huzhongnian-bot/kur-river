// /api/drafts/:id —— GET 轮询草稿；PATCH 导演定密（§5.7 ③）。
// GET 响应派生 outputTruncated（越权截断提示位，见 server/generation）；
// content 有两种形态：ready 前是流式临时单段，ready 后是契约解析的终稿段落。
// PATCH 两种形式（均仅 ready 态）：
//   { segments: [{kind, text, visibility}] } —— 段落级定密，整体替换草稿段落
//   { text } —— M1 兼容形式，单 public 段落化
import type { MessageSegment, SegmentKind, SegmentVisibility } from '@kur-river/core';
import { getRepos } from '@/server/repos';
import { isOutputTruncated, singleSegment } from '@/server/generation';
import { badRequest, handleError, json, notFound, readBody, type RouteCtx } from '@/server/http';
import { pathUuid, reqString } from '@/server/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = RouteCtx<{ id: string }>;

const SEGMENT_KINDS: readonly SegmentKind[] = ['speech', 'action', 'thought'];
const SEGMENT_VISIBILITIES: readonly SegmentVisibility[] = [
  'public',
  'self_director',
  'director',
];

/** 定密段落校验：数组非空；kind/visibility 枚举；text 去两侧空白后非空（存 trim 后文本） */
function parseSegments(raw: unknown): MessageSegment[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest('字段 segments 必须是非空数组');
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw badRequest(`segments[${i}] 必须是对象 {kind, text, visibility}`);
    }
    const { kind, text, visibility } = item as Record<string, unknown>;
    if (typeof kind !== 'string' || !SEGMENT_KINDS.includes(kind as SegmentKind)) {
      throw badRequest(`segments[${i}].kind 必须是 ${SEGMENT_KINDS.join(' / ')} 之一`);
    }
    if (
      typeof visibility !== 'string' ||
      !SEGMENT_VISIBILITIES.includes(visibility as SegmentVisibility)
    ) {
      throw badRequest(
        `segments[${i}].visibility 必须是 ${SEGMENT_VISIBILITIES.join(' / ')} 之一`,
      );
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw badRequest(`segments[${i}].text 必须是非空字符串`);
    }
    return {
      kind: kind as SegmentKind,
      text: text.trim(),
      visibility: visibility as SegmentVisibility,
    };
  });
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const draft = await getRepos().drafts.get(id);
    if (!draft) throw notFound(`草稿不存在：${id}`);
    return json({ ...draft, outputTruncated: isOutputTruncated(id) });
  } catch (err) {
    return handleError(err);
  }
}

/** PATCH 定密（§5.7 ③）：{ segments } 整体替换段落；{ text } 兼容 M1 单 public 段落化 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const id = pathUuid((await ctx.params).id);
    const repos = getRepos();
    const draft = await repos.drafts.get(id);
    if (!draft) throw notFound(`草稿不存在：${id}`);
    if (draft.status !== 'ready') {
      throw badRequest(`仅 ready 态草稿可编辑（当前 ${draft.status}）`);
    }
    const body = await readBody(req);
    const hasSegments = 'segments' in body;
    const hasText = 'text' in body;
    if (hasSegments && hasText) throw badRequest('segments 与 text 只能二选一');
    if (!hasSegments && !hasText) throw badRequest('PATCH 需要 segments 或 text 字段');

    const content = hasSegments
      ? parseSegments(body.segments)
      : singleSegment(reqString(body, 'text'));
    const updated = await repos.drafts.updateContent(id, content);
    if (!updated) throw notFound(`草稿不存在：${id}`);
    return json({ ...updated, outputTruncated: isOutputTruncated(id) });
  } catch (err) {
    return handleError(err);
  }
}
