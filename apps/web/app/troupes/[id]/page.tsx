'use client';

// 团队详情（§7.2）：大纲/基调、默认化身、成员管理（从角色池选）、场次列表 + 新建场次。
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, body, del, patch } from '@/components/api';
import {
  btnCls,
  btnDangerCls,
  btnGhostCls,
  cardCls,
  ErrorBanner,
  inputCls,
  labelCls,
  PageShell,
} from '@/components/ui';

interface Troupe {
  id: string;
  worldId: string;
  name: string;
  outline: unknown;
  toneDirective: string | null;
  defaultPersonaId: string | null;
  memberCharacterIds: string[];
}

interface Character {
  id: string;
  name: string;
}

interface Persona {
  id: string;
  name: string;
}

interface Session {
  id: string;
  title: string | null;
  status: string;
  createdAt: string;
}

export default function TroupeDetailPage() {
  const params = useParams<{ id: string }>();
  const troupeId = params.id;
  const [troupe, setTroupe] = useState<Troupe | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 团队信息编辑
  const [tone, setTone] = useState('');
  const [outline, setOutline] = useState('');
  const [personaId, setPersonaId] = useState('');

  // 新建场次
  const [sessionTitle, setSessionTitle] = useState('');
  const [scene, setScene] = useState('');
  const [castPick, setCastPick] = useState<Set<string>>(new Set());

  // 成员管理
  const [memberPick, setMemberPick] = useState('');

  const load = useCallback(async () => {
    const t = await api<Troupe>(`/api/troupes/${troupeId}`);
    setTroupe(t);
    setTone(t.toneDirective ?? '');
    setOutline(typeof t.outline === 'string' ? t.outline : t.outline ? JSON.stringify(t.outline, null, 2) : '');
    setPersonaId(t.defaultPersonaId ?? '');
    const [cs, ps, ss] = await Promise.all([
      api<Character[]>(`/api/worlds/${t.worldId}/characters`),
      api<Persona[]>(`/api/worlds/${t.worldId}/personas`),
      api<Session[]>(`/api/troupes/${troupeId}/sessions`),
    ]);
    setCharacters(cs);
    setPersonas(ps);
    setSessions(ss);
  }, [troupeId]);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  const run = (fn: () => Promise<void>) => void fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));

  async function saveTroupe() {
    await api(`/api/troupes/${troupeId}`, patch({
      toneDirective: tone || null,
      outline: outline || null,
      defaultPersonaId: personaId || null,
    }));
    await load();
  }

  async function addMember() {
    if (!memberPick) return;
    await api(`/api/troupes/${troupeId}/members`, body({ characterId: memberPick }));
    setMemberPick('');
    await load();
  }

  async function removeMember(characterId: string) {
    await api(`/api/troupes/${troupeId}/members/${characterId}`, del());
    await load();
  }

  async function createSession() {
    await api(`/api/troupes/${troupeId}/sessions`, body({
      title: sessionTitle || null,
      scene: scene || null,
      castCharacterIds: [...castPick],
    }));
    setSessionTitle('');
    setScene('');
    setCastPick(new Set());
    await load();
  }

  async function removeSession(id: string) {
    await api(`/api/sessions/${id}`, del());
    await load();
  }

  if (!troupe) {
    return (
      <PageShell title="团队" nav={<Link href="/worlds">← 世界书列表</Link>}>
        <ErrorBanner error={error} />
        <p className="text-sm text-gray-500">加载中…</p>
      </PageShell>
    );
  }

  const members = troupe.memberCharacterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is Character => !!c);
  const nonMembers = characters.filter((c) => !troupe.memberCharacterIds.includes(c.id));

  return (
    <PageShell
      title={`团队：${troupe.name}`}
      nav={<Link href={`/worlds/${troupe.worldId}`}>← 世界书</Link>}
    >
      <ErrorBanner error={error} />
      <div className="space-y-4">
        <section className={cardCls}>
          <h2 className="mb-3 font-semibold">大纲与基调</h2>
          <div className="space-y-2">
            <div>
              <label className={labelCls}>团队基调指令（注入所有生成）</label>
              <input className={inputCls} value={tone} onChange={(e) => setTone(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>剧目大纲</label>
              <textarea
                className={inputCls}
                rows={4}
                value={outline}
                onChange={(e) => setOutline(e.target.value)}
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label className={labelCls}>默认化身（{'{{user}}'} 宏来源）</label>
                <select
                  className={inputCls}
                  value={personaId}
                  onChange={(e) => setPersonaId(e.target.value)}
                >
                  <option value="">（不绑定）</option>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <button className={btnCls} onClick={() => run(saveTroupe)}>
                保存
              </button>
            </div>
          </div>
        </section>

        <section className={cardCls}>
          <h2 className="mb-3 font-semibold">成员（{members.length}）</h2>
          <div className="mb-3 flex gap-2">
            <select
              className={`${inputCls} max-w-xs`}
              value={memberPick}
              onChange={(e) => setMemberPick(e.target.value)}
            >
              <option value="">从角色池选角…</option>
              {nonMembers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className={btnCls} disabled={!memberPick} onClick={() => run(addMember)}>
              加入
            </button>
          </div>
          <ul className="space-y-1 text-sm">
            {members.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <span>{c.name}</span>
                <span className="flex-1" />
                <button className={btnDangerCls} onClick={() => run(() => removeMember(c.id))}>
                  移出
                </button>
              </li>
            ))}
            {members.length === 0 && <li className="text-gray-400">还没有成员。</li>}
          </ul>
        </section>

        <section className={cardCls}>
          <h2 className="mb-3 font-semibold">场次（{sessions.length}）</h2>
          <div className="mb-3 space-y-2 rounded bg-gray-50 p-3">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <input
                className={inputCls}
                placeholder="场次标题（可空）"
                value={sessionTitle}
                onChange={(e) => setSessionTitle(e.target.value)}
              />
              <input
                className={inputCls}
                placeholder="场景设定（地点/时间/氛围，可空）"
                value={scene}
                onChange={(e) => setScene(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-xs text-gray-500">在场成员：</span>
              {members.map((c) => (
                <label key={c.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={castPick.has(c.id)}
                    onChange={(e) =>
                      setCastPick((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(c.id);
                        else next.delete(c.id);
                        return next;
                      })
                    }
                  />
                  {c.name}
                </label>
              ))}
              {members.length === 0 && <span className="text-xs text-gray-400">先加成员</span>}
              <span className="flex-1" />
              <button
                className={btnCls}
                disabled={members.length === 0}
                onClick={() => run(createSession)}
              >
                新建场次
              </button>
            </div>
          </div>
          <ul className="space-y-1 text-sm">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                <Link href={`/sessions/${s.id}`} className="font-medium text-blue-600 hover:underline">
                  {s.title || '（无标题场次）'}
                </Link>
                <span className="rounded bg-gray-100 px-1.5 text-xs">{s.status}</span>
                <span className="text-xs text-gray-400">{new Date(s.createdAt).toLocaleString()}</span>
                <span className="flex-1" />
                <button className={btnDangerCls} onClick={() => run(() => removeSession(s.id))}>
                  删除
                </button>
              </li>
            ))}
            {sessions.length === 0 && <li className="text-gray-400">还没有场次。</li>}
          </ul>
        </section>
      </div>
    </PageShell>
  );
}
