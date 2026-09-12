// 段落载荷校验（drafts PATCH 与 messages PATCH 共用）。
// 与 app/api/drafts/[id]/route.ts 的本地实现同规则（M3 起新路由统一走这里；
// 旧路由保持不动以免惊扰已验证路径，后续再收敛）。
import type { MessageSegment, SegmentKind, SegmentVisibility } from '@kur-river/core';
import { badRequest } from './http';

const SEGMENT_KINDS: readonly SegmentKind[] = ['speech', 'action', 'thought'];
const SEGMENT_VISIBILITIES: readonly SegmentVisibility[] = [
  'public',
  'self_director',
  'director',
];

/** 段落数组校验：数组非空；kind/visibility 枚举；text 去两侧空白后非空（存 trim 后文本） */
export function parseSegments(raw: unknown): MessageSegment[] {
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
