// 页面共用的小组件与样式约定（shadcn token 体系，PC 优先）。
// 颜色一律走语义 token（primary/card/border/muted/destructive），
// 题材皮肤只改 CSS 变量即可整体换色（见 app/skins/）。
// M4 移动端：输入控件移动端 text-base（≥16px 防 iOS 聚焦自动放大），
// 按钮移动端 min-h 44px（触摸目标），均不影响 PC（md: 前缀）。
'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

export const inputCls =
  'w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-base md:text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50';
export const btnCls =
  'inline-flex items-center justify-center rounded-lg bg-primary px-3 py-1 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50 min-h-[44px] md:min-h-0';
export const btnGhostCls =
  'inline-flex items-center justify-center rounded-lg border border-border bg-background px-3 py-1 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 min-h-[44px] md:min-h-0';
export const btnDangerCls =
  'inline-flex items-center justify-center rounded-lg border border-destructive/30 px-2 py-0.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50';
export const cardCls = 'rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xs';
export const labelCls = 'mb-1 block text-xs font-medium text-muted-foreground';

export function PageShell({
  title,
  nav,
  children,
}: {
  title: string;
  nav?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex flex-wrap items-center gap-4 border-b border-border pb-4">
        <Link href="/" className="text-lg font-bold tracking-tight text-foreground">
          kur-river
        </Link>
        <span className="text-border">/</span>
        <h1 className="text-lg font-semibold">{title}</h1>
        <nav className="ml-auto flex items-center gap-3 text-sm text-primary">{nav}</nav>
      </header>
      {children}
    </main>
  );
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {error}
    </div>
  );
}
