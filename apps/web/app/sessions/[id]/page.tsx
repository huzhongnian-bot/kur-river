'use client';

// ★ 演出界面（§7.2 核心战场）：消息流 + 底部发言栏（AI 角色 = 提示词生成草稿 /
// 旁白·化身 = 直接落盘）→ 定密台（§5.7 ③：草稿按段落展示，kind 徽标 +
// 每段可见性开关 + 文本可编辑，确认落盘）+ 依次反应（§5.4 严格串行）+
// 补发可见性（§2.2）。
// PC 三栏：左在场名单，中剧情流 + 草稿卡 + 底部发言栏，右生成控制（模型覆盖/依次反应）。
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, body, del, patch } from '@/components/api';
import { AmbientLayer, readAmbience } from '@/components/ambient/AmbientLayer';
import { SkinScope } from '@/components/skin';
import { btnCls, btnGhostCls, ErrorBanner, inputCls, PageShell } from '@/components/ui';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface MessageSegment {
  kind: 'speech' | 'action' | 'thought';
  text: string;
  visibility: 'public' | 'self_director' | 'director';
}

interface Message {
  id: string;
  seq: number;
  senderType: 'director' | 'character' | 'player';
  senderId: string | null;
  content: MessageSegment[];
  createdAt: string;
}

interface Draft {
  id: string;
  sessionId: string;
  characterId: string;
  directive: string | null;
  content: MessageSegment[] | null;
  status: 'queued' | 'generating' | 'ready' | 'failed' | 'confirmed' | 'discarded';
  error: string | null;
  resolvedModel: string | null;
  /** §5.7 ② 越权截断提示位（API 派生） */
  outputTruncated?: boolean;
  updatedAt: string;
}

interface ReactionProgress {
  current: number;
  total: number;
  currentCharacterId: string | null;
  remaining: number;
}

interface Session {
  id: string;
  troupeId: string;
  title: string | null;
  scene: unknown;
  status: string;
  castCharacterIds: string[];
  reactionProgress: ReactionProgress | null;
}

interface Troupe {
  id: string;
  worldId: string;
  name: string;
  skin: string;
  defaultPersonaId: string | null;
}

interface Named {
  id: string;
  name: string;
}

interface Connection extends Named {
  enabled: boolean;
}

const POLL_MS = 900;
const ACTIVE_STATUSES = new Set(['queued', 'generating', 'ready', 'failed']);

const VISIBILITY_LABEL: Record<MessageSegment['visibility'], string> = {
  public: '公开',
  self_director: '本人+导演',
  director: '仅导演',
};

const KIND_LABEL: Record<MessageSegment['kind'], string> = {
  speech: '台词',
  action: '动作',
  thought: '心声',
};

/** 非 public 段落在导演视图里的视觉降级（§2.3：导演可见全部，但一眼可辨） */
const SEGMENT_DIM_CLS: Record<MessageSegment['visibility'], string> = {
  public: '',
  self_director: 'italic text-muted-foreground',
  director: 'italic text-director',
};

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export default function SessionStagePage() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;

  const [session, setSession] = useState<Session | null>(null);
  const [troupe, setTroupe] = useState<Troupe | null>(null);
  const [characters, setCharacters] = useState<Named[]>([]);
  const [personas, setPersonas] = useState<Named[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeDraft, setActiveDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 底部发言栏：AI 角色模式 = 输入当作提示词 → AI 生成草稿 → 定密台确认落盘；
  // 旁白/化身模式 = 文本直接落盘发言
  const [speakerId, setSpeakerId] = useState('');
  const [composerMode, setComposerMode] = useState<'character' | 'player' | 'director'>(
    'character',
  );
  const [composerText, setComposerText] = useState('');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [presets, setPresets] = useState<Named[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [model, setModel] = useState('');
  const [presetId, setPresetId] = useState('');
  const [busy, setBusy] = useState(false);

  // 化身发言的目标化身（发言栏 player 模式）
  const [speakPersonaId, setSpeakPersonaId] = useState('');

  // 定密台：ready 态按段落编辑（kind 只读徽标 + visibility 下拉 + 文本）
  const [editSegments, setEditSegments] = useState<MessageSegment[]>([]);
  // 定密台阅读流：正在行内编辑的段落下标（null = 纯阅读态）
  const [editingSeg, setEditingSeg] = useState<number | null>(null);

  // 消息操作：编辑（段落级）/ 改提示词重演（截断到该条之前 + 重新生成）
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMsgSegs, setEditMsgSegs] = useState<MessageSegment[]>([]);
  const [replayId, setReplayId] = useState<string | null>(null);
  const [replayPrompt, setReplayPrompt] = useState('');

  // 视角切换（信息不对称演示）：'director' = 全部段落；否则按该角色过滤（§2.3 第二级）
  const [viewAs, setViewAs] = useState<string>('director');

  // 移动端抽屉（M4 §7.2）：左右栏在 <md 收进抽屉；底部固定输入栏见底部
  const [leftDrawer, setLeftDrawer] = useState(false);
  const [rightDrawer, setRightDrawer] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);

  const nameOf = useCallback(
    (m: Message): string => {
      if (m.senderType === 'director') return '旁白';
      const pool = m.senderType === 'character' ? characters : personas;
      return pool.find((x) => x.id === m.senderId)?.name ?? '（未知）';
    },
    [characters, personas],
  );

  /** §2.3 第二级过滤的前端镜像：视角角色看到的段落 */
  const visibleSegmentsOf = useCallback(
    (m: Message): MessageSegment[] => {
      if (viewAs === 'director') return m.content;
      const isOwn = m.senderType === 'character' && m.senderId === viewAs;
      return m.content.filter(
        (s) => s.visibility === 'public' || (isOwn && s.visibility === 'self_director'),
      );
    },
    [viewAs],
  );

  // ---- 数据加载与轮询 ----

  const refresh = useCallback(async () => {
    const [s, msgs, drafts] = await Promise.all([
      api<Session>(`/api/sessions/${sessionId}`),
      api<Message[]>(`/api/sessions/${sessionId}/messages?limit=200`),
      api<Draft[]>(`/api/sessions/${sessionId}/drafts`),
    ]);
    setSession(s);
    setMessages(msgs);
    setDrafts(drafts);
    // listBySession 按创建时间倒序：取最近的未完结草稿进入草稿卡
    setActiveDraft(drafts.find((d) => ACTIVE_STATUSES.has(d.status)) ?? null);
  }, [sessionId]);

  useEffect(() => {
    void (async () => {
      try {
        const s = await api<Session>(`/api/sessions/${sessionId}`);
        setSession(s);
        const t = await api<Troupe>(`/api/troupes/${s.troupeId}`);
        setTroupe(t);
        const [cs, ps, conns, prs] = await Promise.all([
          api<Named[]>(`/api/worlds/${t.worldId}/characters`),
          api<Named[]>(`/api/worlds/${t.worldId}/personas`),
          api<Connection[]>('/api/providers/connections'),
          api<Named[]>('/api/providers/presets'),
        ]);
        setCharacters(cs);
        setPersonas(ps);
        setConnections(conns.filter((c) => c.enabled));
        setPresets(prs);
        if (s.castCharacterIds.length > 0) setSpeakerId((v) => v || s.castCharacterIds[0]);
        if (t.defaultPersonaId) setSpeakPersonaId(t.defaultPersonaId);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [sessionId, refresh]);

  useEffect(() => {
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // 定密台编辑态：草稿切换 / 跃迁到 ready 时以终稿段落重置；
  // ready 内的轮询不重置（保留导演未保存的修改）
  useEffect(() => {
    if (activeDraft?.status === 'ready') setEditSegments(activeDraft.content ?? []);
    setEditingSeg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDraft?.id, activeDraft?.status]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const run = (fn: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    return fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  // ---- 操作 ----

  async function generate() {
    if (!speakerId) return;
    setBusy(true);
    try {
      await run(async () => {
        await api(`/api/sessions/${sessionId}/drafts`, body({
          characterId: speakerId,
          directive: composerText.trim() || null,
          connectionId: connectionId || undefined,
          model: model || undefined,
          presetId: presetId || undefined,
        }));
        setComposerText('');
        await refresh();
      });
    } finally {
      setBusy(false);
    }
  }

  /** §5.4 依次反应：发言栏当前输入作为批次共用指令，在场名单顺序严格串行 */
  async function startReactions() {
    setBusy(true);
    try {
      await run(async () => {
        await api(`/api/sessions/${sessionId}/reactions`, body({
          directive: composerText.trim() || null,
        }));
        await refresh();
      });
    } finally {
      setBusy(false);
    }
  }

  async function cancelReactions() {
    await run(async () => {
      await api(`/api/sessions/${sessionId}/reactions/cancel`, body({}));
      await refresh();
    });
  }

  /** §2.2 补发可见性：把历史消息批量授权给（晚加入的）在场角色 */
  async function grantVisibility(c: Named) {
    await run(async () => {
      const res = await api<{ granted: number }>(
        `/api/sessions/${sessionId}/messages/grant-visibility`,
        body({ characterId: c.id }),
      );
      setNotice(`已为 ${c.name} 补发 ${res.granted} 条历史消息的可见性。`);
      await refresh();
    });
  }

  const draftText = activeDraft?.content?.map((s) => s.text).join('\n') ?? '';
  const segmentsDirty =
    activeDraft?.status === 'ready' &&
    JSON.stringify(editSegments) !== JSON.stringify(activeDraft.content ?? []);

  /** 定密保存（§5.7 ③）：PATCH segments 整体替换草稿段落 */
  async function saveSegments() {
    if (!activeDraft || !segmentsDirty) return;
    await run(async () => {
      await api(`/api/drafts/${activeDraft.id}`, patch({ segments: editSegments }));
      await refresh();
    });
  }

  async function confirm() {
    if (!activeDraft) return;
    await run(async () => {
      // 确认语义 = 落盘当前 content；有未保存的定密修改先 PATCH 再确认
      if (segmentsDirty) {
        await api(`/api/drafts/${activeDraft.id}`, patch({ segments: editSegments }));
      }
      await api(`/api/drafts/${activeDraft.id}/confirm`, body({}));
      await refresh();
    });
  }

  async function regenerate() {
    if (!activeDraft) return;
    await run(async () => {
      await api(`/api/drafts/${activeDraft.id}/regenerate`, body({}));
      await refresh();
    });
  }

  async function discard() {
    if (!activeDraft) return;
    await run(async () => {
      await api(`/api/drafts/${activeDraft.id}/discard`, body({}));
      await refresh();
    });
  }

  async function speak() {
    if (!composerText.trim()) return;
    await run(async () => {
      await api(`/api/sessions/${sessionId}/messages`, body({
        senderType: composerMode === 'player' ? 'player' : 'director',
        text: composerText,
        personaId: composerMode === 'player' ? speakPersonaId || undefined : undefined,
      }));
      setComposerText('');
      await refresh();
    });
  }

  // ---- 消息操作：编辑 / 删除 / 改提示词重演 ----

  /** 尽力找回生成该消息时用的提示词：同角色的已确认草稿里，时间与消息落盘最接近的一份
      （confirm 同事务内草稿 updatedAt 与消息 createdAt 仅差毫秒级，故不按先后而按最近匹配） */
  function sourceDirectiveOf(m: Message): string {
    if (m.senderType !== 'character') return '';
    const at = new Date(m.createdAt).getTime();
    const candidates = drafts
      .filter((d) => d.status === 'confirmed' && d.characterId === m.senderId)
      .map((d) => ({ d, gap: Math.abs(new Date(d.updatedAt).getTime() - at) }))
      .filter((c) => c.gap <= 60_000)
      .sort((a, b) => a.gap - b.gap);
    return candidates[0]?.d.directive ?? '';
  }

  function startEdit(m: Message) {
    setReplayId(null);
    setEditingId(m.id);
    setEditMsgSegs(m.content.map((s) => ({ ...s })));
  }

  async function saveMessageEdit(m: Message) {
    await run(async () => {
      await api(`/api/sessions/${sessionId}/messages/${m.id}`, patch({ segments: editMsgSegs }));
      setEditingId(null);
      await refresh();
    });
  }

  async function removeMessage(m: Message) {
    if (!window.confirm(`删除 #${m.seq}（${nameOf(m)}）？此操作不可撤销。`)) return;
    await run(async () => {
      await api(`/api/sessions/${sessionId}/messages/${m.id}`, del());
      if (editingId === m.id) setEditingId(null);
      if (replayId === m.id) setReplayId(null);
      await refresh();
    });
  }

  function startReplay(m: Message) {
    setEditingId(null);
    setReplayId(m.id);
    setReplayPrompt(sourceDirectiveOf(m));
  }

  /** 改提示词重演：截断到该条之前（§7.1 truncate，悬挂草稿一并废弃），按新提示词重新生成 */
  async function replayMessage(m: Message) {
    if (m.senderType !== 'character' || !m.senderId) return;
    await run(async () => {
      await api(`/api/sessions/${sessionId}/messages/truncate`, body({ seq: m.seq - 1 }));
      await api(`/api/sessions/${sessionId}/drafts`, body({
        characterId: m.senderId,
        directive: replayPrompt.trim() || null,
        connectionId: connectionId || undefined,
        model: model || undefined,
        presetId: presetId || undefined,
      }));
      setReplayId(null);
      await refresh();
    });
  }

  if (!session || !troupe) {
    return (
      <SkinScope skin={troupe?.skin}>
        <PageShell title="演出" nav={<Link href="/worlds">← 世界书列表</Link>}>
          <ErrorBanner error={error} />
          <p className="text-sm text-muted-foreground">加载中…</p>
        </PageShell>
      </SkinScope>
    );
  }

  const castCharacters = session.castCharacterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Named => !!c);
  const speakerName = characters.find((c) => c.id === activeDraft?.characterId)?.name ?? '';
  const batch = session.reactionProgress;
  const batchCurrentName =
    characters.find((c) => c.id === batch?.currentCharacterId)?.name ?? '';
  const composerSelectCls =
    'rounded-lg border border-input bg-muted/50 px-2 py-1.5 text-sm text-foreground focus:border-primary/50 focus:bg-card focus:outline-none';
  const composerSubmitDisabled =
    composerMode === 'character'
      ? busy || !speakerId || castCharacters.length === 0
      : !composerText.trim() || (composerMode === 'player' && !speakPersonaId);
  // 题材皮肤：scene.skin（单场覆盖）> troupe.skin；氛围动画读 scene.ambience
  const sceneObj =
    session.scene && typeof session.scene === 'object'
      ? (session.scene as Record<string, unknown>)
      : null;
  const activeSkin = typeof sceneObj?.skin === 'string' ? sceneObj.skin : troupe.skin;

  return (
    <SkinScope skin={activeSkin}>
      <AmbientLayer ambience={readAmbience(session.scene)} />
      <div className="relative z-10">
      <PageShell
      title={`演出：${session.title || '（无标题场次）'}`}
      nav={
        <>
          <span className="text-muted-foreground">{troupe.name}</span>
          <Link href={`/troupes/${troupe.id}`}>← 团队</Link>
        </>
      }
    >
      <ErrorBanner error={error} />
      {notice && (
        <div className="mb-4 rounded border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          {notice}
        </div>
      )}
      {/* 移动端顶栏（M4）：左右抽屉开关；PC 不显示 */}
      <div className="mb-2 flex items-center gap-2 md:hidden">
        <button
          className={`${btnGhostCls} flex-1`}
          onClick={() => {
            setLeftDrawer(true);
            setRightDrawer(false);
          }}
        >
          ☰ 在场角色
        </button>
        <button
          className={`${btnGhostCls} flex-1`}
          onClick={() => {
            setRightDrawer(true);
            setLeftDrawer(false);
          }}
        >
          导演面板 ☰
        </button>
      </div>
      {/* 抽屉背板（仅移动端） */}
      {(leftDrawer || rightDrawer) && (
        <div
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
          onClick={() => {
            setLeftDrawer(false);
            setRightDrawer(false);
          }}
        />
      )}
      <div className="pb-32 md:grid md:grid-cols-[180px_1fr_300px] md:gap-4 md:pb-0">
        {/* 左栏：在场名单（上下场/点名 + 补发可见性，§2.2）；移动端左抽屉 */}
        <aside
          className={`fixed inset-y-0 left-0 z-40 w-64 space-y-2 overflow-y-auto bg-card p-3 shadow-xl transition-transform md:visible md:static md:z-auto md:w-auto md:translate-x-0 md:overflow-visible md:bg-transparent md:p-0 md:shadow-none md:transition-none ${
            leftDrawer ? 'visible translate-x-0' : 'invisible -translate-x-full'
          }`}
        >
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground">在场角色</h2>
            <button className={`${btnGhostCls} md:hidden`} onClick={() => setLeftDrawer(false)}>
              收起
            </button>
          </div>
          {castCharacters.map((c) => (
            <div key={c.id} className="space-y-1">
              <button
                className={`block w-full rounded border px-2 py-1.5 text-left text-sm ${
                  speakerId === c.id
                    ? 'border-primary bg-accent font-medium'
                    : 'border-border hover:bg-muted'
                }`}
                onClick={() => {
                  setSpeakerId(c.id);
                  setComposerMode('character'); // 点名 = 指定 AI 角色发言
                  setLeftDrawer(false); // 移动端点名后收抽屉（PC 为 no-op 态）
                }}
              >
                {c.name}
                {speakerId === c.id && <span className="ml-1 text-xs text-primary">◀ 点名</span>}
                {batch?.currentCharacterId === c.id && (
                  <span className="ml-1 text-xs text-warning">◀ 反应中</span>
                )}
              </button>
              {messages.length > 0 && (
                <button
                  className="block w-full rounded border border-border px-2 py-0.5 text-left text-xs text-muted-foreground hover:bg-muted"
                  title="把上场前的历史消息可见性补发给该角色（§2.2）"
                  onClick={() => void grantVisibility(c)}
                >
                  补发可见性
                </button>
              )}
            </div>
          ))}
          {castCharacters.length === 0 && (
            <p className="text-xs text-muted-foreground">没有在场角色，请回团队页面上场。</p>
          )}
          {typeof session.scene === 'string' && session.scene && (
            <div className="mt-4 rounded bg-muted/50 p-2 text-xs text-muted-foreground">
              <div className="mb-1 font-semibold">场景</div>
              {session.scene}
            </div>
          )}
        </aside>

        {/* 中栏：剧情流 + 草稿卡 */}
        <section className="space-y-3">
          {/* 视角切换（§2.3 信息不对称演示）：导演 = 全部段落；角色 = 段落级过滤 */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>视角</span>
            <select
              className="rounded border border-input px-1.5 py-0.5"
              value={viewAs}
              onChange={(e) => setViewAs(e.target.value)}
            >
              <option value="director">导演（全部段落）</option>
              {castCharacters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（按可见性过滤）
                </option>
              ))}
            </select>
          </div>
          <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
            {messages.map((m) => {
              const segs = visibleSegmentsOf(m);
              return (
                <div key={m.id} data-testid="message-card" className="rounded border border-border bg-card p-3 shadow-sm">
                  <div className="mb-1 flex items-baseline gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">#{m.seq}</span>
                    <span
                      className={`font-semibold ${
                        m.senderType === 'director'
                          ? 'text-director'
                          : m.senderType === 'player'
                            ? 'text-success'
                            : 'text-primary'
                      }`}
                    >
                      {nameOf(m)}
                    </span>
                    {/* 消息操作（导演视角才显示）：编辑 / 改提示词重演 / 删除 */}
                    {viewAs === 'director' && editingId !== m.id && replayId !== m.id && (
                      <span className="ml-auto flex gap-1">
                        <button
                          className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          onClick={() => startEdit(m)}
                        >
                          编辑
                        </button>
                        {m.senderType === 'character' && (
                          <button
                            className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            title="修改提示词并从这条重新生成（此条及其后消息会被删除）"
                            onClick={() => startReplay(m)}
                          >
                            改提示词重演
                          </button>
                        )}
                        <button
                          className="rounded border border-destructive/30 px-1.5 py-0.5 text-destructive hover:bg-destructive/10"
                          onClick={() => void removeMessage(m)}
                        >
                          删除
                        </button>
                      </span>
                    )}
                  </div>
                  {editingId === m.id ? (
                    <div className="space-y-2">
                      {editMsgSegs.map((seg, i) => (
                        <div key={i} className="rounded border border-border bg-muted/50 p-2">
                          <div className="mb-1 flex items-center gap-2 text-xs">
                            <span className="rounded bg-muted px-1 text-muted-foreground">
                              {KIND_LABEL[seg.kind]}
                            </span>
                            <select
                              className="rounded border border-input px-1 py-0.5"
                              value={seg.visibility}
                              onChange={(e) =>
                                setEditMsgSegs((prev) =>
                                  prev.map((s, j) =>
                                    j === i
                                      ? {
                                          ...s,
                                          visibility: e.target
                                            .value as MessageSegment['visibility'],
                                        }
                                      : s,
                                  ),
                                )
                              }
                            >
                              {(
                                Object.keys(VISIBILITY_LABEL) as MessageSegment['visibility'][]
                              ).map((v) => (
                                <option key={v} value={v}>
                                  {VISIBILITY_LABEL[v]}
                                </option>
                              ))}
                            </select>
                          </div>
                          <textarea
                            className={inputCls}
                            rows={2}
                            value={seg.text}
                            onChange={(e) =>
                              setEditMsgSegs((prev) =>
                                prev.map((s, j) => (j === i ? { ...s, text: e.target.value } : s)),
                              )
                            }
                          />
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <button className={btnCls} onClick={() => void saveMessageEdit(m)}>
                          保存修改
                        </button>
                        <button className={btnGhostCls} onClick={() => setEditingId(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  ) : replayId === m.id ? (
                    <div className="space-y-2 rounded border border-warning/30 bg-warning/10 p-2">
                      <p className="text-xs text-warning">
                        改提示词重演：将从 #{m.seq} 重新生成——此条及其后消息会被删除，
                        生成结果进草稿卡，确认后落盘。
                      </p>
                      <textarea
                        className={`${inputCls} bg-card`}
                        rows={2}
                        placeholder="新提示词（留空 = 角色自发反应）"
                        value={replayPrompt}
                        onChange={(e) => setReplayPrompt(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <button className={btnCls} onClick={() => void replayMessage(m)}>
                          重演生成
                        </button>
                        <button className={btnGhostCls} onClick={() => setReplayId(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  ) : segs.length === 0 ? (
                    <div className="text-xs italic text-muted-foreground">（此条在当前视角不可见）</div>
                  ) : (
                    // 阅读流：类型靠排版区分（心声斜体），非公开段落挂可见性小标
                    segs.map((seg, i) => (
                      <p
                        key={i}
                        className={`mt-1 whitespace-pre-wrap text-sm ${
                          seg.kind === 'thought' ? 'italic' : ''
                        } ${SEGMENT_DIM_CLS[seg.visibility]}`}
                      >
                        {seg.text}
                        {seg.visibility !== 'public' && (
                          <span className="ml-1 rounded bg-muted px-1 align-middle text-xs">
                            {VISIBILITY_LABEL[seg.visibility]}
                          </span>
                        )}
                      </p>
                    ))
                  )}
                </div>
              );
            })}
            {messages.length === 0 && (
              <p className="text-sm text-muted-foreground">剧情尚未开始——确认开场草稿，或先来一条旁白。</p>
            )}
            <div ref={bottomRef} />
          </div>

          {/* 草稿卡（定密台，§5.7 ③） */}
          {activeDraft && (
            <div data-testid="draft-card" className="rounded border-2 border-warning/30 bg-warning/10 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm">
                <span className="font-semibold">草稿 · {speakerName}</span>
                <span className="rounded bg-warning/20 px-1.5 text-xs">{activeDraft.status}</span>
                {batch && <span className="text-xs text-warning">依次反应 {batch.current}/{batch.total}</span>}
                {activeDraft.resolvedModel && (
                  <span className="text-xs text-muted-foreground">模型：{activeDraft.resolvedModel}</span>
                )}
                {activeDraft.directive && (
                  <span className="truncate text-xs text-muted-foreground">
                    指令：{activeDraft.directive}
                  </span>
                )}
              </div>
              {activeDraft.outputTruncated && (
                <div className="mb-2 rounded bg-warning/10 px-2 py-1 text-xs text-warning">
                  已截断越权内容：模型替其他在场角色写了台词/动作，该部分已从草稿中移除（§5.7 ②）。
                </div>
              )}
              {activeDraft.status === 'failed' ? (
                <div className="mb-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
                  {activeDraft.error}
                </div>
              ) : activeDraft.status === 'ready' ? (
                <div>
                  {/* 阅读流（§5.7 ③ 定密台）：与上屏消息同款排版，审稿即通读；
                      点击段落原地展开编辑器（类型/可见性/文本），完成收起 */}
                  <div className="rounded-lg bg-card px-3 py-2 leading-relaxed">
                    {editSegments.map((seg, i) =>
                      editingSeg === i ? (
                        <div key={i} className="my-2 rounded-lg border border-warning/40 p-2">
                          <div className="mb-1 flex items-center gap-2 text-xs">
                            <select
                              aria-label="段落类型"
                              className="rounded border border-input bg-background px-1 py-0.5"
                              value={seg.kind}
                              onChange={(e) =>
                                setEditSegments((prev) =>
                                  prev.map((s, j) =>
                                    j === i
                                      ? { ...s, kind: e.target.value as MessageSegment['kind'] }
                                      : s,
                                  ),
                                )
                              }
                            >
                              {(Object.keys(KIND_LABEL) as MessageSegment['kind'][]).map((k) => (
                                <option key={k} value={k}>
                                  {KIND_LABEL[k]}
                                </option>
                              ))}
                            </select>
                            <select
                              aria-label="可见性"
                              className="rounded border border-input bg-background px-1 py-0.5"
                              value={seg.visibility}
                              onChange={(e) =>
                                setEditSegments((prev) =>
                                  prev.map((s, j) =>
                                    j === i
                                      ? {
                                          ...s,
                                          visibility: e.target
                                            .value as MessageSegment['visibility'],
                                        }
                                      : s,
                                  ),
                                )
                              }
                            >
                              {(
                                Object.keys(VISIBILITY_LABEL) as MessageSegment['visibility'][]
                              ).map((v) => (
                                <option key={v} value={v}>
                                  {VISIBILITY_LABEL[v]}
                                </option>
                              ))}
                            </select>
                            <button
                              className="ml-auto rounded border border-border px-2 py-0.5 hover:bg-muted"
                              onClick={() => setEditingSeg(null)}
                            >
                              完成
                            </button>
                          </div>
                          <textarea
                            autoFocus
                            className={inputCls}
                            rows={Math.min(8, Math.max(2, seg.text.split('\n').length + 1))}
                            value={seg.text}
                            onChange={(e) =>
                              setEditSegments((prev) =>
                                prev.map((s, j) => (j === i ? { ...s, text: e.target.value } : s)),
                              )
                            }
                          />
                        </div>
                      ) : (
                        <p
                          key={i}
                          data-testid="draft-segment"
                          title={`${KIND_LABEL[seg.kind]} · ${VISIBILITY_LABEL[seg.visibility]}（点击编辑）`}
                          onClick={() => setEditingSeg(i)}
                          className={`-mx-1 mt-1.5 cursor-text whitespace-pre-wrap rounded px-1 text-sm transition-colors first:mt-0 hover:bg-muted/60 ${
                            seg.kind === 'thought' ? 'italic text-muted-foreground' : ''
                          }`}
                        >
                          {seg.text}
                          {seg.visibility !== 'public' && (
                            <span className="ml-1 rounded bg-muted px-1 align-middle text-xs text-muted-foreground">
                              {VISIBILITY_LABEL[seg.visibility]}
                            </span>
                          )}
                        </p>
                      ),
                    )}
                  </div>
                  {segmentsDirty && (
                    <div className="mt-2 flex items-center gap-2 text-xs text-warning">
                      <span>定密有未保存修改（确认落盘时会自动保存）</span>
                      <button className={btnGhostCls} onClick={() => void saveSegments()}>
                        保存定密
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <textarea
                  className={`${inputCls} bg-card`}
                  rows={5}
                  value={draftText}
                  readOnly
                  placeholder="（生成中…）"
                />
              )}
              <div className="mt-2 flex gap-2">
                <button
                  className={btnCls}
                  disabled={activeDraft.status !== 'ready'}
                  onClick={() => void confirm()}
                >
                  确认落盘
                </button>
                <button
                  className={btnGhostCls}
                  disabled={activeDraft.status !== 'ready' && activeDraft.status !== 'failed'}
                  onClick={() => void regenerate()}
                >
                  重抽
                </button>
                <button
                  className={btnGhostCls}
                  disabled={activeDraft.status === 'confirmed' || activeDraft.status === 'discarded'}
                  onClick={() => void discard()}
                >
                  放弃
                </button>
              </div>
            </div>
          )}

          {/* 底部发言栏（PC/移动统一）：AI 角色模式 = 输入当提示词 → 生成草稿 →
              上方草稿卡确认落盘输出；旁白/化身模式 = 文本直接落盘发言。
              移动端 fixed 吸底，PC 静态位于中栏底部。Ctrl/⌘+Enter 提交。 */}
          <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/95 p-3 backdrop-blur md:static md:z-auto md:rounded-xl md:border md:shadow-sm">
            <textarea
              className="max-h-56 min-h-20 w-full resize-y rounded-lg border border-input bg-muted/50 px-3 py-2 text-base leading-relaxed focus:border-primary/50 focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring/30 md:text-sm"
              rows={3}
              placeholder={
                composerMode === 'character'
                  ? '提示词：告诉 AI 这一拍怎么演（留空 = 角色自发反应）'
                  : '直接落盘的文本，支持 {{char}} / {{user}} 宏'
              }
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !composerSubmitDisabled) {
                  e.preventDefault();
                  if (composerMode === 'character') void generate();
                  else void speak();
                }
              }}
            />
            <div className="mt-2 flex items-center gap-2">
              <select
                className={`${composerSelectCls} w-24 flex-none`}
                value={composerMode}
                onChange={(e) =>
                  setComposerMode(e.target.value as 'character' | 'player' | 'director')
                }
                title="发言方式"
              >
                <option value="character">AI 角色</option>
                <option value="player">化身</option>
                <option value="director">旁白</option>
              </select>
              {composerMode === 'character' && (
                <select
                  className={`${composerSelectCls} min-w-0 flex-1 md:flex-none`}
                  value={speakerId}
                  onChange={(e) => setSpeakerId(e.target.value)}
                  title="发言角色"
                >
                  {castCharacters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              {composerMode === 'player' && (
                <select
                  className={`${composerSelectCls} min-w-0 flex-1 md:flex-none`}
                  value={speakPersonaId}
                  onChange={(e) => setSpeakPersonaId(e.target.value)}
                  title="发言化身"
                >
                  <option value="">选择化身…</option>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              <span className="hidden flex-1 truncate text-right text-xs text-muted-foreground md:inline">
                {composerMode === 'character'
                  ? '提示词 → 草稿 → 确认落盘输出'
                  : '支持 {{char}} / {{user}} 宏'}
                　·　Ctrl+Enter 提交
              </span>
              {composerMode === 'character' ? (
                <button
                  className={`${btnCls} min-w-24 flex-none`}
                  disabled={composerSubmitDisabled}
                  onClick={() => void generate()}
                >
                  ✨ 生成
                </button>
              ) : (
                <button
                  className={`${btnCls} min-w-24 flex-none`}
                  disabled={composerSubmitDisabled}
                  onClick={() => void speak()}
                >
                  发言
                </button>
              )}
            </div>
          </div>
        </section>

        {/* 右栏：导演面板；移动端右抽屉 */}
        <aside
          className={`fixed inset-y-0 right-0 z-40 w-72 space-y-4 overflow-y-auto bg-card p-3 shadow-xl transition-transform md:visible md:static md:z-auto md:w-auto md:translate-x-0 md:overflow-visible md:bg-transparent md:p-0 md:shadow-none md:transition-none ${
            rightDrawer ? 'visible translate-x-0' : 'invisible translate-x-full'
          }`}
        >
          <div className="mb-1 flex items-center justify-end md:hidden">
            <button className={btnGhostCls} onClick={() => setRightDrawer(false)}>
              收起
            </button>
          </div>
          <div className="rounded border border-border bg-card p-3 shadow-sm">
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">生成控制</h2>
            <div className="space-y-2">
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">单次模型覆盖（可空 = 按绑定链）</summary>
                <div className="mt-2 space-y-2">
                  <select
                    className={inputCls}
                    value={connectionId}
                    onChange={(e) => setConnectionId(e.target.value)}
                  >
                    <option value="">连接：默认</option>
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className={inputCls}
                    placeholder="模型名（可空）"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  />
                  <select
                    className={inputCls}
                    value={presetId}
                    onChange={(e) => setPresetId(e.target.value)}
                  >
                    <option value="">预设：默认</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </details>
              {/* §5.4 依次反应：严格串行，A 落盘后 B 才开始生成 */}
              <button
                className={`${btnGhostCls} w-full`}
                disabled={busy || !!batch || castCharacters.length < 2}
                title="在场角色按名单顺序依次反应（严格串行，§5.4），发言栏当前输入作为批次共用指令"
                onClick={() => void startReactions()}
              >
                依次反应（全员）
              </button>
              {batch && (
                <div className="rounded border border-warning/30 bg-warning/10 px-2 py-1.5 text-xs text-warning">
                  <div>
                    依次反应进行中：第 {batch.current}/{batch.total} 位
                    {batchCurrentName && ` · 当前：${batchCurrentName}`}
                  </div>
                  <button
                    className="mt-1 rounded border border-warning/50 px-2 py-0.5 hover:bg-warning/10"
                    onClick={() => void cancelReactions()}
                  >
                    取消批次
                  </button>
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
      </PageShell>
      </div>
    </SkinScope>
  );
}
