import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// 开发便利：从仓库根目录加载 .env.local / .env（.env.example 的复制目标），
// apps/web/.env.local 或真实环境变量优先
for (const name of ['.env.local', '.env']) {
  const envPath = path.resolve(process.cwd(), '../../', name);
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const nextConfig: NextConfig = {
  transpilePackages: ['@kur-river/core', '@kur-river/llm', '@kur-river/db'],
  // dev 悬浮指示器（左下 N 按钮）会压住演出页的移动端底部发言栏，关掉
  devIndicators: false,
};

export default nextConfig;
