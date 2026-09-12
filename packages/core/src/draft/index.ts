// 草稿状态机与确认流（DESIGN §2.2 Draft、§5.6）。
//
// 合法迁移：
//   queued → generating → ready → confirmed / discarded
//        queued → discarded（排队中取消）
//        generating → failed（保留 error）
// regenerate 不由原草稿承载：failed/ready 态的重抽一律创建新 draft
// （沿用或改写模型配置快照，§5.6），因此 failed/confirmed/discarded 无出边。

import type { NewDraft, NewMessage, Repos } from '../repos/index';
import type { Draft, DraftStatus, Message, MessageSegment } from '../types';

export const DRAFT_TRANSITIONS: Readonly<Record<DraftStatus, readonly DraftStatus[]>> = {
  queued: ['generating', 'discarded'],
  generating: ['ready', 'failed'],
  ready: ['confirmed', 'discarded'],
  failed: [],
  confirmed: [],
  discarded: [],
};

export class DraftTransitionError extends Error {
  constructor(
    readonly from: DraftStatus,
    readonly to: DraftStatus,
  ) {
    super(`非法草稿状态迁移：${from} → ${to}`);
    this.name = 'DraftTransitionError';
  }
}

export function canTransitionDraft(from: DraftStatus, to: DraftStatus): boolean {
  return DRAFT_TRANSITIONS[from].includes(to);
}

export function assertDraftTransition(from: DraftStatus, to: DraftStatus): void {
  if (!canTransitionDraft(from, to)) throw new DraftTransitionError(from, to);
}

/**
 * 由"草稿段落数组 + 当前在场名单"构造待落盘 Message（§2.2）。
 * visibleTo 为创建时的在场名单快照——中途上场的角色看不到上场前的剧情，
 * 这是刻意的信息不对称（可见性快照语义）。
 */
export function buildMessageFromDraft(
  draft: Pick<Draft, 'sessionId' | 'characterId' | 'content'>,
  castCharacterIds: string[],
  opts: { content?: MessageSegment[] } = {},
): NewMessage {
  const content = opts.content ?? draft.content;
  if (!content || content.length === 0) {
    throw new Error('草稿没有可落盘的段落内容');
  }
  return {
    sessionId: draft.sessionId,
    senderType: 'character',
    senderId: draft.characterId,
    content,
    visibleTo: [...castCharacterIds],
  };
}

/**
 * 状态迁移编排：校验合法性后落库（§5.6）。
 * 失败态记录 error；离开 failed 语义不存在（regenerate 走新 draft）。
 */
export async function transitionDraft(
  repos: Repos,
  draftId: string,
  to: DraftStatus,
  opts: { error?: string | null } = {},
): Promise<Draft> {
  const draft = await repos.drafts.get(draftId);
  if (!draft) throw new Error(`草稿不存在：${draftId}`);
  assertDraftTransition(draft.status, to);
  const updated = await repos.drafts.updateStatus(draftId, to, opts);
  if (!updated) throw new Error(`草稿不存在：${draftId}`);
  return updated;
}

/**
 * 确认编排（§5.6 confirm）：ready → 构造 Message → 仓储事务落盘。
 * opts.content 为导演定密后的最终段落（§5.7 ③），缺省用草稿现状。
 * seq 分配的事务串行化在仓储实现内完成（db：SELECT ... FOR UPDATE）。
 */
export async function confirmDraft(
  repos: Repos,
  draftId: string,
  opts: { content?: MessageSegment[] } = {},
): Promise<{ draft: Draft; message: Message }> {
  const draft = await repos.drafts.get(draftId);
  if (!draft) throw new Error(`草稿不存在：${draftId}`);
  assertDraftTransition(draft.status, 'confirmed');
  const castIds = await repos.sessionCast.list(draft.sessionId);
  const message = buildMessageFromDraft(draft, castIds, opts);
  return repos.drafts.confirm(draftId, {
    content: message.content,
    visibleTo: message.visibleTo,
  });
}

/** regenerate（§5.6）：以原草稿为模板创建新 draft，可改写指令与模型快照 */
export async function regenerateDraft(
  repos: Repos,
  sourceDraftId: string,
  overrides: Partial<Pick<NewDraft, 'directive' | 'resolvedConnectionId' | 'resolvedModel' | 'resolvedParams'>> = {},
): Promise<Draft> {
  const source = await repos.drafts.get(sourceDraftId);
  if (!source) throw new Error(`草稿不存在：${sourceDraftId}`);
  return repos.drafts.create({
    sessionId: source.sessionId,
    characterId: source.characterId,
    directive: overrides.directive !== undefined ? overrides.directive : source.directive,
    triggerMessageId: source.triggerMessageId,
    resolvedConnectionId:
      overrides.resolvedConnectionId !== undefined
        ? overrides.resolvedConnectionId
        : source.resolvedConnectionId,
    resolvedModel:
      overrides.resolvedModel !== undefined ? overrides.resolvedModel : source.resolvedModel,
    resolvedParams:
      overrides.resolvedParams !== undefined
        ? overrides.resolvedParams
        : source.resolvedParams,
  });
}
