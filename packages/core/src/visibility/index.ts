// 可见性过滤规则（DESIGN §2.3 第二级：段落级过滤，纯逻辑）。
// 第一级消息级粗筛（visible_to @> [...]）在仓储 SQL 层完成，见 db/repos。

import type { Message, MessageSegment } from '../types';

/**
 * 按"读者角色"渲染一条消息的可见段落（§2.3）：
 * - 导演视图（readerCharacterId = null）→ 全部段落
 * - 本人（senderType=character 且 senderId 为本人）→ public + self_director
 * - 他人（含导演旁白与玩家化身消息，角色读者没有"本人"一说）→ 仅 public
 */
export function renderMessageForReader(
  message: Pick<Message, 'senderType' | 'senderId' | 'content'>,
  readerCharacterId: string | null,
): MessageSegment[] {
  if (readerCharacterId === null) return message.content;
  const isOwn =
    message.senderType === 'character' && message.senderId === readerCharacterId;
  return message.content.filter(
    (seg) => seg.visibility === 'public' || (isOwn && seg.visibility === 'self_director'),
  );
}

/** 渲染文本：可见段落按原序以换行拼接；无可见段落时返回 null（整条对读者隐藏） */
export function renderedText(
  message: Pick<Message, 'senderType' | 'senderId' | 'content'>,
  readerCharacterId: string | null,
): string | null {
  const segments = renderMessageForReader(message, readerCharacterId);
  if (segments.length === 0) return null;
  return segments.map((s) => s.text).join('\n');
}

/** 段落的 public 文本（§5.2 ② 世界书扫描源用：公开信息才进共享扫描） */
export function publicText(segments: MessageSegment[]): string {
  return segments
    .filter((s) => s.visibility === 'public')
    .map((s) => s.text)
    .join('\n');
}

/** 消息的 public 文本（扫描源用） */
export function messagePublicText(message: Pick<Message, 'content'>): string {
  return publicText(message.content);
}
