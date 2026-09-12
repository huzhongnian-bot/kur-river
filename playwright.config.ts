import { defineConfig } from '@playwright/test';
import { APP_PASSWORD } from './tests/smoke/infra';

export default defineConfig({
  testDir: './tests/smoke',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 120_000,
  globalTimeout: 10 * 60_000,
  retries: 0,
  globalSetup: './tests/smoke/global-setup.ts',
  globalTeardown: './tests/smoke/global-teardown.ts',
  reporter: [['list']],
  use: {
    // 端口在 global-setup 里随机分配，经 process.env.SMOKE_WEB_BASE 传给测试
    // 密码门（middleware.ts）：浏览器自动携带 Basic 凭证
    httpCredentials: { username: 'director', password: APP_PASSWORD },
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
});
