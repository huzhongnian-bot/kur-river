import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'kur-river',
  description: '导演制 AI 跑团平台',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'kur-river',
  },
};

// M4 移动端：device-width + viewport-fit=cover（抽屉/底部栏适配刘海屏），
// theme-color 与 manifest 一致
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0f172a',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
