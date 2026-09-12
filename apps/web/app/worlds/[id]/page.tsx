'use client';

// 世界书详情（§7.2）：条目管理 / 角色池 / 化身 / 团队列表 四块。
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

// ---------------------------------------------------------------------------
// 类型（镜像 API 出参）
// ---------------------------------------------------------------------------

interface Character {
  id: string;
  name: string;
  card: unknown;
  secrets: unknown;
  talkativeness: number;
}

interface Persona {
  id: string;
  name: string;
  description: string | null;
}

interface Troupe {
  id: string;
  name: string;
  toneDirective: string | null;
}

interface LorebookEntry {
  id: string;
  ownerType: 'world' | 'character' | 'session';
  ownerId: string;
  visibility: 'public' | 'private';
  keys: string[];
  secondaryKeys: string[] | null;
  content: string;
  position: 'before_char' | 'after_char' | 'at_depth';
  depth: number | null;
  insertionOrder: number;
  enabled: boolean;
}

interface World {
  id: string;
  title: string;
}

// ---------------------------------------------------------------------------
// 角色池
// ---------------------------------------------------------------------------

const emptyCharForm = {
  id: null as string | null,
  name: '',
  description: '',
  personality: '',
  scenario: '',
  first_mes: '',
  mes_example: '',
  secrets: '',
  talkativeness: '0.5',
};

function cardOf(char: Character): Record<string, unknown> {
  if (char.card && typeof char.card === 'object') {
    const raw = char.card as Record<string, unknown>;
    if (raw.data && typeof raw.data === 'object') return raw.data as Record<string, unknown>;
    return raw;
  }
  return {};
}

function CharactersSection({
  worldId,
  onError,
  onChanged,
}: {
  worldId: string;
  onError: (e: string) => void;
  onChanged: (characters: Character[]) => void;
}) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [form, setForm] = useState(emptyCharForm);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    const list = await api<Character[]>(`/api/worlds/${worldId}/characters`);
    setCharacters(list);
    onChanged(list);
  }, [worldId, onChanged]);

  useEffect(() => {
    void load().catch((e) => onError(e instanceof Error ? e.message : String(e)));
  }, [load, onError]);

  function edit(char: Character) {
    const card = cardOf(char);
    setForm({
      id: char.id,
      name: char.name,
      description: String(card.description ?? ''),
      personality: String(card.personality ?? ''),
      scenario: String(card.scenario ?? ''),
      first_mes: String(card.first_mes ?? ''),
      mes_example: String(card.mes_example ?? ''),
      secrets: typeof char.secrets === 'string' ? char.secrets : char.secrets ? JSON.stringify(char.secrets) : '',
      talkativeness: String(char.talkativeness),
    });
    setShowForm(true);
  }

  async function save() {
    const payload = {
      name: form.name,
      card: {
        description: form.description,
        personality: form.personality,
        scenario: form.scenario,
        first_mes: form.first_mes,
        mes_example: form.mes_example,
      },
      secrets: form.secrets || null,
      talkativeness: Number(form.talkativeness) || 0.5,
    };
    try {
      if (form.id) {
        await api(`/api/worlds/${worldId}/characters/${form.id}`, patch(payload));
      } else {
        await api(`/api/worlds/${worldId}/characters`, body(payload));
      }
      setForm(emptyCharForm);
      setShowForm(false);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/worlds/${worldId}/characters/${id}`, del());
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  const set = (key: keyof typeof emptyCharForm) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <section className={cardCls}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">角色池（{characters.length}）</h2>
        <button
          className={btnGhostCls}
          onClick={() => {
            setForm(emptyCharForm);
            setShowForm((v) => !v);
          }}
        >
          {showForm ? '收起' : '新建角色'}
        </button>
      </div>
      {showForm && (
        <div className="mb-4 space-y-2 rounded bg-gray-50 p-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div>
              <label className={labelCls}>角色名 *</label>
              <input className={inputCls} value={form.name} onChange={set('name')} />
            </div>
            <div>
              <label className={labelCls}>talkativeness（0-1）</label>
              <input
                className={inputCls}
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={form.talkativeness}
                onChange={set('talkativeness')}
              />
            </div>
          </div>
          {(
            [
              ['description', '卡 · description'],
              ['personality', '卡 · personality'],
              ['scenario', '卡 · scenario'],
              ['first_mes', '卡 · first_mes（开场白，支持 {{char}} / {{user}}）'],
              ['mes_example', '卡 · mes_example'],
              ['secrets', 'secrets（仅注入本人上下文）'],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <label className={labelCls}>{label}</label>
              <textarea className={inputCls} rows={2} value={form[key]} onChange={set(key)} />
            </div>
          ))}
          <div className="flex gap-2">
            <button className={btnCls} disabled={!form.name.trim()} onClick={() => void save()}>
              {form.id ? '保存修改' : '创建角色'}
            </button>
            <button
              className={btnGhostCls}
              onClick={() => {
                setForm(emptyCharForm);
                setShowForm(false);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      <ul className="space-y-1 text-sm">
        {characters.map((c) => (
          <li key={c.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-gray-50">
            <span className="font-medium">{c.name}</span>
            <span className="text-xs text-gray-400">talkativeness {c.talkativeness}</span>
            <span className="flex-1" />
            <button className={btnGhostCls} onClick={() => edit(c)}>
              编辑
            </button>
            <button className={btnDangerCls} onClick={() => void remove(c.id)}>
              删除
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 化身
// ---------------------------------------------------------------------------

function PersonasSection({
  worldId,
  onError,
  onChanged,
}: {
  worldId: string;
  onError: (e: string) => void;
  onChanged: (personas: Persona[]) => void;
}) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const load = useCallback(async () => {
    const list = await api<Persona[]>(`/api/worlds/${worldId}/personas`);
    setPersonas(list);
    onChanged(list);
  }, [worldId, onChanged]);

  useEffect(() => {
    void load().catch((e) => onError(e instanceof Error ? e.message : String(e)));
  }, [load, onError]);

  function resetForm() {
    setEditId(null);
    setName('');
    setDescription('');
  }

  async function save() {
    try {
      if (editId) {
        await api(
          `/api/worlds/${worldId}/personas/${editId}`,
          patch({ name, description: description || null }),
        );
      } else {
        await api(`/api/worlds/${worldId}/personas`, body({ name, description: description || null }));
      }
      resetForm();
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/worlds/${worldId}/personas/${id}`, del());
      if (editId === id) resetForm();
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className={cardCls}>
      <h2 className="mb-3 font-semibold">{'导演化身（{{user}} 宏来源）'}</h2>
      <div className="mb-3 flex flex-wrap gap-2">
        <input
          className={`${inputCls} max-w-xs`}
          placeholder="化身名 *"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={`${inputCls} flex-1`}
          placeholder="人设描述（可空）"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button className={btnCls} disabled={!name.trim()} onClick={() => void save()}>
          {editId ? '保存修改' : '新建'}
        </button>
        {editId && (
          <button className={btnGhostCls} onClick={resetForm}>
            取消编辑
          </button>
        )}
      </div>
      <ul className="space-y-1 text-sm">
        {personas.map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <span className="font-medium">{p.name}</span>
            <span className="flex-1 truncate text-gray-500">{p.description}</span>
            <button
              className={btnGhostCls}
              onClick={() => {
                setEditId(p.id);
                setName(p.name);
                setDescription(p.description ?? '');
              }}
            >
              编辑
            </button>
            <button className={btnDangerCls} onClick={() => void remove(p.id)}>
              删除
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 世界书条目
// ---------------------------------------------------------------------------

const emptyEntryForm = {
  id: null as string | null,
  ownerType: 'world' as 'world' | 'character',
  ownerId: '',
  visibility: 'public' as 'public' | 'private',
  keys: '',
  secondaryKeys: '',
  content: '',
  position: 'before_char' as 'before_char' | 'after_char' | 'at_depth',
  depth: '',
  insertionOrder: '100',
  enabled: true,
};

function LorebookSection({
  worldId,
  characters,
  onError,
}: {
  worldId: string;
  characters: Character[];
  onError: (e: string) => void;
}) {
  const [entries, setEntries] = useState<LorebookEntry[]>([]);
  const [form, setForm] = useState(emptyEntryForm);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setEntries(await api<LorebookEntry[]>(`/api/worlds/${worldId}/lorebook`));
  }, [worldId]);

  useEffect(() => {
    void load().catch((e) => onError(e instanceof Error ? e.message : String(e)));
  }, [load, onError]);

  const charName = (id: string) => characters.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  function edit(entry: LorebookEntry) {
    setForm({
      id: entry.id,
      ownerType: entry.ownerType === 'character' ? 'character' : 'world',
      ownerId: entry.ownerType === 'character' ? entry.ownerId : '',
      visibility: entry.visibility,
      keys: entry.keys.join(', '),
      secondaryKeys: (entry.secondaryKeys ?? []).join(', '),
      content: entry.content,
      position: entry.position,
      depth: entry.depth === null ? '' : String(entry.depth),
      insertionOrder: String(entry.insertionOrder),
      enabled: entry.enabled,
    });
    setShowForm(true);
  }

  async function save() {
    const payload = {
      ownerType: form.ownerType,
      ownerId: form.ownerType === 'character' ? form.ownerId : undefined,
      visibility: form.visibility,
      keys: form.keys,
      secondaryKeys: form.secondaryKeys || null,
      content: form.content,
      position: form.position,
      depth: form.depth === '' ? null : Number(form.depth),
      insertionOrder: Number(form.insertionOrder) || 0,
      enabled: form.enabled,
    };
    try {
      if (form.id) {
        await api(`/api/worlds/${worldId}/lorebook/${form.id}`, patch(payload));
      } else {
        await api(`/api/worlds/${worldId}/lorebook`, body(payload));
      }
      setForm(emptyEntryForm);
      setShowForm(false);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/worlds/${worldId}/lorebook/${id}`, del());
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggle(entry: LorebookEntry) {
    try {
      await api(`/api/worlds/${worldId}/lorebook/${entry.id}`, patch({ enabled: !entry.enabled }));
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className={cardCls}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">世界书条目（{entries.length}）</h2>
        <button
          className={btnGhostCls}
          onClick={() => {
            setForm(emptyEntryForm);
            setShowForm((v) => !v);
          }}
        >
          {showForm ? '收起' : '新建条目'}
        </button>
      </div>
      {showForm && (
        <div className="mb-4 space-y-2 rounded bg-gray-50 p-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <div>
              <label className={labelCls}>scope</label>
              <select
                className={inputCls}
                value={form.ownerType}
                onChange={(e) =>
                  setForm((f) => ({ ...f, ownerType: e.target.value as 'world' | 'character' }))
                }
              >
                <option value="world">world（全团生效）</option>
                <option value="character">character（随角色）</option>
              </select>
            </div>
            {form.ownerType === 'character' && (
              <div>
                <label className={labelCls}>所属角色</label>
                <select
                  className={inputCls}
                  value={form.ownerId}
                  onChange={(e) => setForm((f) => ({ ...f, ownerId: e.target.value }))}
                >
                  <option value="">选择角色…</option>
                  {characters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className={labelCls}>visibility</label>
              <select
                className={inputCls}
                value={form.visibility}
                onChange={(e) =>
                  setForm((f) => ({ ...f, visibility: e.target.value as 'public' | 'private' }))
                }
              >
                <option value="public">public</option>
                <option value="private">private</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>position</label>
              <select
                className={inputCls}
                value={form.position}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    position: e.target.value as typeof f.position,
                  }))
                }
              >
                <option value="before_char">before_char</option>
                <option value="after_char">after_char</option>
                <option value="at_depth">at_depth</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>insertion_order（小者优先）</label>
              <input
                className={inputCls}
                type="number"
                value={form.insertionOrder}
                onChange={(e) => setForm((f) => ({ ...f, insertionOrder: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelCls}>depth（at_depth 时）</label>
              <input
                className={inputCls}
                type="number"
                value={form.depth}
                onChange={(e) => setForm((f) => ({ ...f, depth: e.target.value }))}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div>
              <label className={labelCls}>keys（逗号分隔）</label>
              <input
                className={inputCls}
                value={form.keys}
                onChange={(e) => setForm((f) => ({ ...f, keys: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelCls}>secondary_keys（AND 逻辑，可空）</label>
              <input
                className={inputCls}
                value={form.secondaryKeys}
                onChange={(e) => setForm((f) => ({ ...f, secondaryKeys: e.target.value }))}
              />
            </div>
          </div>
          <div>
            <label className={labelCls}>content *</label>
            <textarea
              className={inputCls}
              rows={3}
              value={form.content}
              onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            enabled
          </label>
          <div className="flex gap-2">
            <button
              className={btnCls}
              disabled={!form.content.trim() || (form.ownerType === 'character' && !form.ownerId)}
              onClick={() => void save()}
            >
              {form.id ? '保存修改' : '创建条目'}
            </button>
            <button
              className={btnGhostCls}
              onClick={() => {
                setForm(emptyEntryForm);
                setShowForm(false);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      <ul className="space-y-1 text-sm">
        {entries.map((e) => (
          <li key={e.id} className="rounded border border-gray-100 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="rounded bg-gray-100 px-1.5 text-xs">
                {e.ownerType === 'world' ? 'world' : `角色:${charName(e.ownerId)}`}
              </span>
              <span className="rounded bg-gray-100 px-1.5 text-xs">{e.visibility}</span>
              <span className="rounded bg-gray-100 px-1.5 text-xs">{e.position}</span>
              <span className="text-xs text-gray-500">keys: {e.keys.join(', ') || '（无）'}</span>
              <span className="flex-1" />
              <button className={btnGhostCls} onClick={() => void toggle(e)}>
                {e.enabled ? '停用' : '启用'}
              </button>
              <button className={btnGhostCls} onClick={() => edit(e)}>
                编辑
              </button>
              <button className={btnDangerCls} onClick={() => void remove(e.id)}>
                删除
              </button>
            </div>
            <p
              className={`mt-1 whitespace-pre-wrap text-xs ${e.enabled ? 'text-gray-600' : 'text-gray-400 line-through'}`}
            >
              {e.content}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 团队列表
// ---------------------------------------------------------------------------

function TroupesSection({
  worldId,
  personas,
  onError,
}: {
  worldId: string;
  personas: Persona[];
  onError: (e: string) => void;
}) {
  const [troupes, setTroupes] = useState<Troupe[]>([]);
  const [name, setName] = useState('');
  const [personaId, setPersonaId] = useState('');

  const load = useCallback(async () => {
    setTroupes(await api<Troupe[]>(`/api/troupes?worldId=${worldId}`));
  }, [worldId]);

  useEffect(() => {
    void load().catch((e) => onError(e instanceof Error ? e.message : String(e)));
  }, [load, onError]);

  async function create() {
    try {
      await api('/api/troupes', body({
        worldId,
        name,
        defaultPersonaId: personaId || null,
      }));
      setName('');
      setPersonaId('');
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/troupes/${id}`, del());
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className={cardCls}>
      <h2 className="mb-3 font-semibold">演出团队（{troupes.length}）</h2>
      <div className="mb-3 flex flex-wrap gap-2">
        <input
          className={`${inputCls} max-w-xs`}
          placeholder="团队名 *"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className={`${inputCls} max-w-xs`}
          value={personaId}
          onChange={(e) => setPersonaId(e.target.value)}
        >
          <option value="">默认化身（可空）</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className={btnCls} disabled={!name.trim()} onClick={() => void create()}>
          新建团队
        </button>
      </div>
      <ul className="space-y-1 text-sm">
        {troupes.map((t) => (
          <li key={t.id} className="flex items-center gap-2">
            <Link href={`/troupes/${t.id}`} className="font-medium text-blue-600 hover:underline">
              {t.name}
            </Link>
            <span className="flex-1 truncate text-gray-500">{t.toneDirective}</span>
            <button className={btnDangerCls} onClick={() => void remove(t.id)}>
              删除
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export default function WorldDetailPage() {
  const params = useParams<{ id: string }>();
  const worldId = params.id;
  const [world, setWorld] = useState<World | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setWorld(await api<World>(`/api/worlds/${worldId}`));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [worldId]);

  return (
    <PageShell
      title={world ? `世界书：${world.title}` : '世界书'}
      nav={<Link href="/worlds">← 世界书列表</Link>}
    >
      <ErrorBanner error={error} />
      <div className="space-y-4">
        <CharactersSection
          worldId={worldId}
          onError={(e) => setError(e)}
          onChanged={setCharacters}
        />
        <PersonasSection worldId={worldId} onError={(e) => setError(e)} onChanged={setPersonas} />
        <LorebookSection worldId={worldId} characters={characters} onError={(e) => setError(e)} />
        <TroupesSection worldId={worldId} personas={personas} onError={(e) => setError(e)} />
      </div>
    </PageShell>
  );
}
