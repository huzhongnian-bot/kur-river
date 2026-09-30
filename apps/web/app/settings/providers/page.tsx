'use client';

// LLM 设置（§7.2 /settings/providers）：连接 CRUD + 拉取模型列表、
// 预设 CRUD、全局默认连接/模型/预设（/api/settings）。
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, body, del, patch, put } from '@/components/api';
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

interface Connection {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  hasApiKey: boolean;
  defaultModel?: string | null;
  enabled: boolean;
}

interface Preset {
  id: string;
  name: string;
  params: Record<string, unknown>;
}

interface Settings {
  defaultConnectionId: string | null;
  defaultPresetId: string | null;
  defaultModel: string | null;
}

const emptyConnForm = { id: null as string | null, name: '', baseUrl: '', apiKey: '', defaultModel: '' };
const emptyPresetForm = { id: null as string | null, name: '', params: '{\n  "temperature": 0.7\n}' };

export default function ProvidersSettingsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [settings, setSettings] = useState<Settings>({
    defaultConnectionId: null,
    defaultPresetId: null,
    defaultModel: null,
  });
  const [connForm, setConnForm] = useState(emptyConnForm);
  const [presetForm, setPresetForm] = useState(emptyPresetForm);
  const [modelsByConn, setModelsByConn] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [cs, ps, st] = await Promise.all([
      api<Connection[]>('/api/providers/connections'),
      api<Preset[]>('/api/providers/presets'),
      api<Settings>('/api/settings'),
    ]);
    setConnections(cs);
    setPresets(ps);
    setSettings(st);
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  const run = (fn: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    return fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  async function saveConnection() {
    await run(async () => {
      const payload = {
        name: connForm.name,
        baseUrl: connForm.baseUrl,
        ...(connForm.apiKey !== '' ? { apiKey: connForm.apiKey } : {}),
        defaultModel: connForm.defaultModel || null,
      };
      if (connForm.id) {
        await api(`/api/providers/connections/${connForm.id}`, patch(payload));
      } else {
        await api('/api/providers/connections', body(payload));
      }
      setConnForm(emptyConnForm);
      await load();
    });
  }

  async function fetchModels(conn: Connection) {
    await run(async () => {
      const res = await api<{ models: string[] }>(`/api/providers/connections/${conn.id}/models`);
      setModelsByConn((m) => ({ ...m, [conn.id]: res.models }));
      setNotice(`「${conn.name}」拉到 ${res.models.length} 个模型`);
    });
  }

  async function savePreset() {
    await run(async () => {
      let params: unknown;
      try {
        params = JSON.parse(presetForm.params || '{}');
      } catch {
        throw new Error('预设 params 不是合法 JSON');
      }
      if (presetForm.id) {
        await api(`/api/providers/presets/${presetForm.id}`, patch({ name: presetForm.name, params }));
      } else {
        await api('/api/providers/presets', body({ name: presetForm.name, params }));
      }
      setPresetForm(emptyPresetForm);
      await load();
    });
  }

  async function saveSettings() {
    await run(async () => {
      await api('/api/settings', put(settings));
      setNotice('全局默认已保存');
      await load();
    });
  }

  return (
    <PageShell title="LLM 设置" nav={<Link href="/">← 首页</Link>}>
      <ErrorBanner error={error} />
      {notice && (
        <div className="mb-4 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          {notice}
        </div>
      )}
      <div className="space-y-4">
        <section className={cardCls}>
          <h2 className="mb-3 font-semibold">连接（openai-compatible）</h2>
          <div className="mb-4 grid grid-cols-1 gap-2 rounded bg-muted/50 p-3 md:grid-cols-2">
            <div>
              <label className={labelCls}>名称 *</label>
              <input
                className={inputCls}
                value={connForm.name}
                onChange={(e) => setConnForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelCls}>baseUrl *（如 https://api.deepseek.com/v1）</label>
              <input
                className={inputCls}
                value={connForm.baseUrl}
                onChange={(e) => setConnForm((f) => ({ ...f, baseUrl: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelCls}>
                apiKey{connForm.id ? '（留空 = 不修改）' : ''}
              </label>
              <input
                className={inputCls}
                type="password"
                value={connForm.apiKey}
                onChange={(e) => setConnForm((f) => ({ ...f, apiKey: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelCls}>默认模型（可空）</label>
              <input
                className={inputCls}
                value={connForm.defaultModel}
                onChange={(e) => setConnForm((f) => ({ ...f, defaultModel: e.target.value }))}
              />
            </div>
            <div className="col-span-2 flex gap-2">
              <button
                className={btnCls}
                disabled={!connForm.name.trim() || !connForm.baseUrl.trim()}
                onClick={() => void saveConnection()}
              >
                {connForm.id ? '保存修改' : '新建连接'}
              </button>
              {connForm.id && (
                <button className={btnGhostCls} onClick={() => setConnForm(emptyConnForm)}>
                  取消编辑
                </button>
              )}
            </div>
          </div>
          <ul className="space-y-2 text-sm">
            {connections.map((c) => (
              <li key={c.id} className="rounded border border-border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground">{c.baseUrl}</span>
                  <span className="rounded bg-muted px-1.5 text-xs">
                    {c.hasApiKey ? '已配 key' : '无 key'}
                  </span>
                  <span className="rounded bg-muted px-1.5 text-xs">
                    默认模型：{c.defaultModel ?? '—'}
                  </span>
                  <span className="flex-1" />
                  <button className={btnGhostCls} onClick={() => void fetchModels(c)}>
                    拉取模型列表
                  </button>
                  <button
                    className={btnGhostCls}
                    onClick={() =>
                      void run(async () => {
                        await api(`/api/providers/connections/${c.id}`, patch({ enabled: !c.enabled }));
                        await load();
                      })
                    }
                  >
                    {c.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    className={btnGhostCls}
                    onClick={() =>
                      setConnForm({
                        id: c.id,
                        name: c.name,
                        baseUrl: c.baseUrl,
                        apiKey: '',
                        defaultModel: c.defaultModel ?? '',
                      })
                    }
                  >
                    编辑
                  </button>
                  <button
                    className={btnDangerCls}
                    onClick={() =>
                      void run(async () => {
                        await api(`/api/providers/connections/${c.id}`, del());
                        await load();
                      })
                    }
                  >
                    删除
                  </button>
                </div>
                {modelsByConn[c.id] && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {modelsByConn[c.id].map((m) => (
                      <button
                        key={m}
                        title="设为该连接的默认模型"
                        className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary hover:bg-primary/20"
                        onClick={() =>
                          void run(async () => {
                            await api(`/api/providers/connections/${c.id}`, patch({ defaultModel: m }));
                            await load();
                          })
                        }
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
            {connections.length === 0 && <li className="text-muted-foreground">还没有连接。</li>}
          </ul>
        </section>

        <section className={cardCls}>
          <h2 className="mb-3 font-semibold">采样参数预设</h2>
          <div className="mb-4 grid grid-cols-1 gap-2 rounded bg-muted/50 p-3 md:grid-cols-2">
            <div>
              <label className={labelCls}>预设名 *</label>
              <input
                className={inputCls}
                value={presetForm.name}
                onChange={(e) => setPresetForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelCls}>params（JSON）</label>
              <textarea
                className={`${inputCls} font-mono`}
                rows={3}
                value={presetForm.params}
                onChange={(e) => setPresetForm((f) => ({ ...f, params: e.target.value }))}
              />
            </div>
            <div className="col-span-2 flex gap-2">
              <button
                className={btnCls}
                disabled={!presetForm.name.trim()}
                onClick={() => void savePreset()}
              >
                {presetForm.id ? '保存修改' : '新建预设'}
              </button>
              {presetForm.id && (
                <button className={btnGhostCls} onClick={() => setPresetForm(emptyPresetForm)}>
                  取消编辑
                </button>
              )}
            </div>
          </div>
          <ul className="space-y-1 text-sm">
            {presets.map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <code className="flex-1 truncate text-xs text-muted-foreground">
                  {JSON.stringify(p.params)}
                </code>
                <button
                  className={btnGhostCls}
                  onClick={() =>
                    setPresetForm({ id: p.id, name: p.name, params: JSON.stringify(p.params, null, 2) })
                  }
                >
                  编辑
                </button>
                <button
                  className={btnDangerCls}
                  onClick={() =>
                    void run(async () => {
                      await api(`/api/providers/presets/${p.id}`, del());
                      await load();
                    })
                  }
                >
                  删除
                </button>
              </li>
            ))}
            {presets.length === 0 && <li className="text-muted-foreground">还没有预设。</li>}
          </ul>
        </section>

        <section className={cardCls}>
          <h2 className="mb-3 font-semibold">全局默认（优先级链最底层）</h2>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <div>
              <label className={labelCls}>默认连接</label>
              <select
                className={inputCls}
                value={settings.defaultConnectionId ?? ''}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, defaultConnectionId: e.target.value || null }))
                }
              >
                <option value="">（未设置）</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>默认模型</label>
              <input
                className={inputCls}
                value={settings.defaultModel ?? ''}
                onChange={(e) => setSettings((s) => ({ ...s, defaultModel: e.target.value || null }))}
              />
            </div>
            <div>
              <label className={labelCls}>默认预设</label>
              <select
                className={inputCls}
                value={settings.defaultPresetId ?? ''}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, defaultPresetId: e.target.value || null }))
                }
              >
                <option value="">（未设置）</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button className={`${btnCls} mt-3`} onClick={() => void saveSettings()}>
            保存全局默认
          </button>
        </section>
      </div>
    </PageShell>
  );
}
