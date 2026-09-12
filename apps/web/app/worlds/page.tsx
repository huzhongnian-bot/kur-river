'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, body, del } from '@/components/api';
import { btnCls, btnDangerCls, cardCls, ErrorBanner, inputCls, PageShell } from '@/components/ui';

interface World {
  id: string;
  title: string;
  premise: unknown;
  createdAt: string;
}

export default function WorldsPage() {
  const [worlds, setWorlds] = useState<World[]>([]);
  const [title, setTitle] = useState('');
  const [premise, setPremise] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setWorlds(await api<World[]>('/api/worlds'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/worlds', body({ title, premise: premise || undefined }));
      setTitle('');
      setPremise('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('删除世界书将连带删除其下角色/团队/场次，确认？')) return;
    try {
      await api(`/api/worlds/${id}`, del());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <PageShell title="世界书" nav={<Link href="/settings/providers">LLM 设置</Link>}>
      <ErrorBanner error={error} />
      <div className={cardCls}>
        <h2 className="mb-3 font-semibold">新建世界书</h2>
        <div className="flex flex-wrap gap-2">
          <input
            className={`${inputCls} max-w-xs`}
            placeholder="标题（必填）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            className={`${inputCls} flex-1`}
            placeholder="世界观前提设定（可空）"
            value={premise}
            onChange={(e) => setPremise(e.target.value)}
          />
          <button className={btnCls} disabled={busy || !title.trim()} onClick={() => void create()}>
            创建
          </button>
        </div>
      </div>
      <div className="mt-4 space-y-2">
        {worlds.length === 0 && <p className="text-sm text-gray-500">还没有世界书。</p>}
        {worlds.map((w) => (
          <div key={w.id} className={`${cardCls} flex items-center gap-4`}>
            <Link href={`/worlds/${w.id}`} className="font-semibold text-blue-600 hover:underline">
              {w.title}
            </Link>
            <span className="flex-1 truncate text-sm text-gray-500">
              {typeof w.premise === 'string' ? w.premise : ''}
            </span>
            <button className={btnDangerCls} onClick={() => void remove(w.id)}>
              删除
            </button>
          </div>
        ))}
      </div>
    </PageShell>
  );
}
