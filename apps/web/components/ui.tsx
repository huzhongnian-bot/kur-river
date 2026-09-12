// 页面共用的小组件与样式约定（Tailwind 功能主义，PC 优先）。
// M4 移动端：输入控件移动端 text-base（≥16px 防 iOS 聚焦自动放大），
// 按钮移动端 min-h 44px（触摸目标），均不影响 PC（md: 前缀）。
'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

export const inputCls =
  'w-full rounded border border-gray-300 px-2 py-1 text-base md:text-sm focus:border-blue-500 focus:outline-none';
export const btnCls =
  'rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400 min-h-[44px] md:min-h-0';
export const btnGhostCls =
  'rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-400 min-h-[44px] md:min-h-0';
export const btnDangerCls =
  'rounded border border-red-300 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50';
export const cardCls = 'rounded border border-gray-200 bg-white p-4 shadow-sm';
export const labelCls = 'mb-1 block text-xs font-medium text-gray-500';

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
      <header className="mb-6 flex flex-wrap items-center gap-4 border-b border-gray-200 pb-4">
        <Link href="/" className="text-lg font-bold text-gray-900">
          kur-river
        </Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-lg font-semibold">{title}</h1>
        <nav className="ml-auto flex items-center gap-3 text-sm text-blue-600">{nav}</nav>
      </header>
      {children}
    </main>
  );
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {error}
    </div>
  );
}
