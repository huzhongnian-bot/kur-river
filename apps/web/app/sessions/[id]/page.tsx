'use client';

// ★ 演出界面（§7.2 核心战场）：消息流 + 导演指令 → 生成草稿 → 轮询 →
// 定密台（§5.7 ③：草稿按段落展示，kind 徽标 + 每段可见性开关 + 文本可编辑，
// 确认落盘）+ 依次反应（§5.4 严格串行）+ 补发可见性（§2.2）+ 导演/化身直接发言。
// PC 三栏：左在场名单，中剧情流 + 草稿卡，右导演面板。
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, body, patch } from '@/components/api';
import { btnCls, btnGhostCls, ErrorBanner, inputCls, labelCls, PageShell } from '@/components/ui';

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
  self_director: 'italic text-gray-500',
  director: 'italic text-purple-500',
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

  // 导演面板
  const [speakerId, setSpeakerId] = useState('');
  const [directive, setDirective] = useState('');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [presets, setPresets] = useState<Named[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [model, setModel] = useState('');
  const [presetId, setPresetId] = useState('');
  const [busy, setBusy] = useState(false);

  // 直接发言
  const [speakType, setSpeakType] = useState<'director' | 'player'>('director');
  const [speakPersonaId, setSpeakPersonaId] = useState('');
  const [speakText, setSpeakText] = useState('');

  // 定密台：ready 态按段落编辑（kind 只读徽标 + visibility 下拉 + 文本）
  const [editSegments, setEditSegments] = useState<MessageSegment[]>([]);

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
          directive: directive || null,
          connectionId: connectionId || undefined,
          model: model || undefined,
          presetId: presetId || undefined,
        }));
        await refresh();
      });
    } finally {
      setBusy(false);
    }
  }

  /** §5.4 依次反应：当前指令作为批次共用指令，在场名单顺序严格串行 */
  async function startReactions() {
    setBusy(true);
    try {
      await run(async () => {
        await api(`/api/sessions/${sessionId}/reactions`, body({
          directive: directive || null,
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
    if (!speakText.trim()) return;
    await run(async () => {
      await api(`/api/sessions/${sessionId}/messages`, body({
        senderType: speakType,
        text: speakText,
        personaId: speakType === 'player' ? speakPersonaId || undefined : undefined,
      }));
      setSpeakText('');
      await refresh();
    });
  }

  if (!session || !troupe) {
    return (
      <PageShell title="演出" nav={<Link href="/worlds">← 世界书列表</Link>}>
        <ErrorBanner error={error} />
        <p className="text-sm text-gray-500">加载中…</p>
      </PageShell>
    );
  }

  const castCharacters = session.castCharacterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Named => !!c);
  const speakerName = characters.find((c) => c.id === activeDraft?.characterId)?.name ?? '';
  const batch = session.reactionProgress;
  const batchCurrentName =
    characters.find((c) => c.id === batch?.currentCharacterId)?.name ?? '';

  return (
    <PageShell
      title={`演出：${session.title || '（无标题场次）'}`}
      nav={
        <>
          <span className="text-gray-400">{troupe.name}</span>
          <Link href={`/troupes/${troupe.id}`}>← 团队</Link>
        </>
      }
    >
      <ErrorBanner error={error} />
      {notice && (
        <div className="mb-4 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
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
          className={`fixed inset-y-0 left-0 z-40 w-64 space-y-2 overflow-y-auto bg-white p-3 shadow-xl transition-transform md:visible md:static md:z-auto md:w-auto md:translate-x-0 md:overflow-visible md:bg-transparent md:p-0 md:shadow-none md:transition-none ${
            leftDrawer ? 'visible translate-x-0' : 'invisible -translate-x-full'
          }`}
        >
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-600">在场角色</h2>
            <button className={`${btnGhostCls} md:hidden`} onClick={() => setLeftDrawer(false)}>
              收起
            </button>
          </div>
          {castCharacters.map((c) => (
            <div key={c.id} className="space-y-1">
              <button
                className={`block w-full rounded border px-2 py-1.5 text-left text-sm ${
                  speakerId === c.id
                    ? 'border-blue-500 bg-blue-50 font-medium'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}
                onClick={() => {
                  setSpeakerId(c.id);
                  setLeftDrawer(false); // 移动端点名后收抽屉（PC 为 no-op 态）
                }}
              >
                {c.name}
                {speakerId === c.id && <span className="ml-1 text-xs text-blue-500">◀ 点名</span>}
                {batch?.currentCharacterId === c.id && (
                  <span className="ml-1 text-xs text-amber-600">◀ 反应中</span>
                )}
              </button>
              {messages.length > 0 && (
                <button
                  className="block w-full rounded border border-gray-200 px-2 py-0.5 text-left text-xs text-gray-500 hover:bg-gray-50"
                  title="把上场前的历史消息可见性补发给该角色（§2.2）"
                  onClick={() => void grantVisibility(c)}
                >
                  补发可见性
                </button>
              )}
            </div>
          ))}
          {castCharacters.length === 0 && (
            <p className="text-xs text-gray-400">没有在场角色，请回团队页面上场。</p>
          )}
          {typeof session.scene === 'string' && session.scene && (
            <div className="mt-4 rounded bg-gray-50 p-2 text-xs text-gray-500">
              <div className="mb-1 font-semibold">场景</div>
              {session.scene}
            </div>
          )}
        </aside>

        {/* 中栏：剧情流 + 草稿卡 */}
        <section className="space-y-3">
          {/* 视角切换（§2.3 信息不对称演示）：导演 = 全部段落；角色 = 段落级过滤 */}
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>视角</span>
            <select
              className="rounded border border-gray-300 px-1.5 py-0.5"
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
                <div key={m.id} className="rounded border border-gray-200 bg-white p-3 shadow-sm">
                  <div className="mb-1 flex items-baseline gap-2 text-xs text-gray-400">
                    <span className="font-mono">#{m.seq}</span>
                    <span
                      className={`font-semibold ${
                        m.senderType === 'director'
                          ? 'text-purple-600'
                          : m.senderType === 'player'
                            ? 'text-green-700'
                            : 'text-blue-700'
                      }`}
                    >
                      {nameOf(m)}
                    </span>
                  </div>
                  {segs.length === 0 ? (
                    <div className="text-xs italic text-gray-300">（此条在当前视角不可见）</div>
                  ) : (
                    segs.map((seg, i) => (
                      <div key={i} className="mt-1">
                        <span className="mr-1 rounded bg-gray-100 px-1 text-xs text-gray-500">
                          {KIND_LABEL[seg.kind]}·{VISIBILITY_LABEL[seg.visibility]}
                        </span>
                        <span
                          className={`whitespace-pre-wrap text-sm ${SEGMENT_DIM_CLS[seg.visibility]}`}
                        >
                          {seg.text}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              );
            })}
            {messages.length === 0 && (
              <p className="text-sm text-gray-400">剧情尚未开始——确认开场草稿，或先来一条旁白。</p>
            )}
            <div ref={bottomRef} />
          </div>

          {/* 草稿卡（定密台，§5.7 ③） */}
          {activeDraft && (
            <div className="rounded border-2 border-amber-300 bg-amber-50 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm">
                <span className="font-semibold">草稿 · {speakerName}</span>
                <span className="rounded bg-amber-200 px-1.5 text-xs">{activeDraft.status}</span>
                {batch && <span className="text-xs text-amber-700">依次反应 {batch.current}/{batch.total}</span>}
                {activeDraft.resolvedModel && (
                  <span className="text-xs text-gray-500">模型：{activeDraft.resolvedModel}</span>
                )}
                {activeDraft.directive && (
                  <span className="truncate text-xs text-gray-500">
                    指令：{activeDraft.directive}
                  </span>
                )}
              </div>
              {activeDraft.outputTruncated && (
                <div className="mb-2 rounded bg-orange-100 px-2 py-1 text-xs text-orange-700">
                  已截断越权内容：模型替其他在场角色写了台词/动作，该部分已从草稿中移除（§5.7 ②）。
                </div>
              )}
              {activeDraft.status === 'failed' ? (
                <div className="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-600">
                  {activeDraft.error}
                </div>
              ) : activeDraft.status === 'ready' ? (
                <div className="space-y-2">
                  {editSegments.map((seg, i) => (
                    <div key={i} className="rounded border border-amber-200 bg-white p-2">
                      <div className="mb-1 flex items-center gap-2 text-xs">
                        <span className="rounded bg-gray-100 px-1 text-gray-600">
                          {KIND_LABEL[seg.kind]}
                        </span>
                        <select
                          className="rounded border border-gray-300 px-1 py-0.5"
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
                      </div>
                      <textarea
                        className={inputCls}
                        rows={2}
                        value={seg.text}
                        onChange={(e) =>
                          setEditSegments((prev) =>
                            prev.map((s, j) => (j === i ? { ...s, text: e.target.value } : s)),
                          )
                        }
                      />
                    </div>
                  ))}
                  {segmentsDirty && (
                    <div className="flex items-center gap-2 text-xs text-amber-700">
                      <span>定密有未保存修改（确认落盘时会自动保存）</span>
                      <button className={btnGhostCls} onClick={() => void saveSegments()}>
                        保存定密
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <textarea
                  className={`${inputCls} bg-white`}
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
        </section>

        {/* 右栏：导演面板；移动端右抽屉 */}
        <aside
          className={`fixed inset-y-0 right-0 z-40 w-72 space-y-4 overflow-y-auto bg-white p-3 shadow-xl transition-transform md:visible md:static md:z-auto md:w-auto md:translate-x-0 md:overflow-visible md:bg-transparent md:p-0 md:shadow-none md:transition-none ${
            rightDrawer ? 'visible translate-x-0' : 'invisible translate-x-full'
          }`}
        >
          <div className="mb-1 flex items-center justify-end md:hidden">
            <button className={btnGhostCls} onClick={() => setRightDrawer(false)}>
              收起
            </button>
          </div>
          <div className="rounded border border-gray-200 bg-white p-3 shadow-sm">
            <h2 className="mb-2 text-sm font-semibold text-gray-600">导演指令</h2>
            <textarea
              className={inputCls}
              rows={3}
              placeholder="例：走向窗边（留空 = 角色自发反应）"
              value={directive}
              onChange={(e) => setDirective(e.target.value)}
            />
            <div className="mt-2 space-y-2">
              <div>
                <label className={labelCls}>发言角色（在场名单）</label>
                <select
                  className={inputCls}
                  value={speakerId}
                  onChange={(e) => setSpeakerId(e.target.value)}
                >
                  {castCharacters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <details className="text-xs text-gray-500">
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
              <button
                className={`${btnCls} w-full`}
                disabled={busy || !speakerId || castCharacters.length === 0}
                onClick={() => void generate()}
              >
                生成草稿
              </button>
              {/* §5.4 依次反应：严格串行，A 落盘后 B 才开始生成 */}
              <button
                className={`${btnGhostCls} w-full`}
                disabled={busy || !!batch || castCharacters.length < 2}
                title="在场角色按名单顺序依次反应（严格串行，§5.4）"
                onClick={() => void startReactions()}
              >
                依次反应（全员）
              </button>
              {batch && (
                <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                  <div>
                    依次反应进行中：第 {batch.current}/{batch.total} 位
                    {batchCurrentName && ` · 当前：${batchCurrentName}`}
                  </div>
                  <button
                    className="mt-1 rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-100"
                    onClick={() => void cancelReactions()}
                  >
                    取消批次
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="rounded border border-gray-200 bg-white p-3 shadow-sm">
            <h2 className="mb-2 text-sm font-semibold text-gray-600">直接发言（落盘）</h2>
            <div className="mb-2 flex gap-3 text-sm">
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={speakType === 'director'}
                  onChange={() => setSpeakType('director')}
                />
                导演旁白
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={speakType === 'player'}
                  onChange={() => setSpeakType('player')}
                />
                化身发言
              </label>
            </div>
            {speakType === 'player' && (
              <select
                className={`${inputCls} mb-2`}
                value={speakPersonaId}
                onChange={(e) => setSpeakPersonaId(e.target.value)}
              >
                <option value="">选择化身…</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <textarea
              className={inputCls}
              rows={3}
              placeholder="支持 {{char}} / {{user}} 宏，落盘前替换"
              value={speakText}
              onChange={(e) => setSpeakText(e.target.value)}
            />
            <button
              className={`${btnCls} mt-2 w-full`}
              disabled={!speakText.trim() || (speakType === 'player' && !speakPersonaId)}
              onClick={() => void speak()}
            >
              发言
            </button>
          </div>
        </aside>
      </div>

      {/* 移动端底部固定输入栏（M4 §7.2：指令输入 + 发言角色 + 生成入口）。
          注意：inputCls 自带 w-full，flex 行内会把按钮挤出视口，这里用无 w-full 的局部类 */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-gray-200 bg-white p-2 md:hidden">
        <div className="flex items-end gap-2">
          <select
            className="w-24 flex-none rounded border border-gray-300 px-2 py-1 text-base focus:border-blue-500 focus:outline-none"
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
          <textarea
            className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-base focus:border-blue-500 focus:outline-none"
            rows={2}
            placeholder="导演指令（留空 = 自发反应）"
            value={directive}
            onChange={(e) => setDirective(e.target.value)}
          />
          <button
            className={`${btnCls} flex-none`}
            disabled={busy || !speakerId || castCharacters.length === 0}
            onClick={() => void generate()}
          >
            生成
          </button>
        </div>
      </div>
    </PageShell>
  );
}
