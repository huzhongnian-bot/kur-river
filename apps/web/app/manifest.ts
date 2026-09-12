// PWA manifest（DESIGN §3：响应式 + PWA manifest；不做离线 SW——
// 生成在服务端，离线无意义）。图标：app/icon.svg（favicon 同源）+
// scripts/generate-icons.mjs 生成的 PNG 占位（场记板意象，无外部素材）。
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'kur-river · 导演制 AI 跑团平台',
    short_name: 'kur-river',
    description: '导演制 AI 跑团平台：世界书 × 导演-演员确认制',
    start_url: '/',
    display: 'standalone',
    background_color: '#0f172a',
    theme_color: '#0f172a',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
