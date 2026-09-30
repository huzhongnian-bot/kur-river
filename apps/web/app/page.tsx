// 首页：保留 M0 的 DB 连通展示，加 M1 导航入口。
import { count, sql } from 'drizzle-orm';
import Link from 'next/link';
import { getDb, worlds } from '@kur-river/db';

export const dynamic = 'force-dynamic';

async function queryDatabase() {
  const db = getDb();
  await db.execute(sql`select 1`);
  const [row] = await db.select({ value: count() }).from(worlds);
  return { worlds: row.value };
}

export default async function Page() {
  let status: { ok: true; worlds: number } | { ok: false; message: string };
  if (!process.env.DATABASE_URL) {
    status = { ok: false, message: 'DATABASE_URL 未设置（根目录 .env.local）' };
  } else {
    try {
      const data = await queryDatabase();
      status = { ok: true, worlds: data.worlds };
    } catch (err) {
      status = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold">kur-river · 导演制 AI 跑团平台</h1>
      <p className={`mt-4 font-mono text-sm ${status.ok ? 'text-success' : 'text-destructive'}`}>
        {status.ok ? `DB OK / worlds: ${status.worlds}` : `DB 连接失败：${status.message}`}
      </p>
      <nav className="mt-8 space-y-3">
        <Link
          href="/worlds"
          className="block rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent"
        >
          <div className="font-semibold">世界书</div>
          <div className="text-sm text-muted-foreground">条目管理 / 角色池 / 化身 / 演出团队</div>
        </Link>
        <Link
          href="/settings/providers"
          className="block rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent"
        >
          <div className="font-semibold">LLM 设置</div>
          <div className="text-sm text-muted-foreground">连接 / 预设 / 全局默认模型</div>
        </Link>
      </nav>
    </main>
  );
}
