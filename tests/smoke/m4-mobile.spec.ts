// M4 冒烟：移动端（390×844，isMobile/touch）核心路径 + PWA manifest。
// 种子数据（世界/角色/团队/场次/mock 连接/全局默认）在测试内用 API 直接造好，
// UI 部分只走演出界面：抽屉点名 → 底部输入栏生成 → 草稿卡确认 → 消息上屏。
import { expect, test, type Page } from '@playwright/test';
import { APP_PASSWORD, MOCK_TEXT } from './infra';

const webBase = process.env.SMOKE_WEB_BASE!;
const mockBase = process.env.SMOKE_MOCK_BASE!;
const AUTH = `Basic ${Buffer.from(`director:${APP_PASSWORD}`).toString('base64')}`;

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});

async function seed() {
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${webBase}${p}`, {
      method,
      headers: {
        authorization: AUTH,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`seed ${method} ${p} → ${res.status}: ${await res.text()}`);
    return res.json();
  };
  const world = await api('POST', '/api/worlds', { title: '移动冒烟世界' });
  const alice = await api('POST', `/api/worlds/${world.id}/characters`, {
    name: 'Alice',
    card: { data: { name: 'Alice', description: '银发剑士。', first_mes: '*亮相* 「{{user}}，开场。」' } },
  });
  const persona = await api('POST', `/api/worlds/${world.id}/personas`, { name: '导演' });
  const troupe = await api('POST', '/api/troupes', {
    worldId: world.id,
    name: '移动团',
    defaultPersonaId: persona.id,
  });
  await api('POST', `/api/troupes/${troupe.id}/members`, { characterId: alice.id });
  const conn = await api('POST', '/api/providers/connections', {
    name: 'mock',
    providerType: 'openai-compatible',
    baseUrl: mockBase,
    apiKey: 'sk-mock',
    defaultModel: 'mock-model',
  });
  await api('PUT', '/api/settings', { defaultConnectionId: conn.id, defaultModel: 'mock-model' });
  const session = await api('POST', `/api/troupes/${troupe.id}/sessions`, {
    title: '移动场',
    castCharacterIds: [alice.id],
  });
  return { session };
}

test('PWA：manifest 可访问且字段正确、图标 200、theme-color meta 存在', async ({ page }) => {
  const res = await fetch(`${webBase}/manifest.webmanifest`);
  expect(res.status).toBe(200);
  const manifest = await res.json();
  expect(manifest.name).toContain('kur-river');
  expect(manifest.display).toBe('standalone');
  expect(manifest.theme_color).toBe('#0f172a');
  expect(manifest.icons.some((i: { src: string }) => i.src.includes('192'))).toBe(true);
  expect(manifest.icons.some((i: { src: string }) => i.src.includes('512'))).toBe(true);

  expect((await fetch(`${webBase}/icons/icon-192.png`)).status).toBe(200);
  expect((await fetch(`${webBase}/icons/icon-512.png`)).status).toBe(200);
  expect((await fetch(`${webBase}/icon.svg`)).status).toBe(200);

  await page.goto(`${webBase}/`);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0f172a');
});

test('移动端演出界面：抽屉点名 → 底部栏生成 → 定密台确认 → 上屏', async ({ page }) => {
  const { session } = await seed();
  await page.goto(`${webBase}/sessions/${session.id}`);

  // 布局断言：底部发言栏可见；桌面端右栏内容（生成控制面板）默认不可见
  const bottomBar = page.locator('div.fixed.bottom-0');
  await expect(bottomBar).toBeVisible();
  await expect(bottomBar.getByPlaceholder(/提示词/)).toBeVisible();
  await expect(page.getByText('生成控制')).toBeHidden();

  // 开场草稿（种子角色带 first_mes）：定密台在移动端完整可用
  const draftCard = page.getByTestId('draft-card');
  await expect(draftCard.getByText('草稿 · Alice')).toBeVisible();
  await expect(draftCard.getByText(/导演，开场/)).toBeVisible();
  await draftCard.getByRole('button', { name: '确认落盘' }).click();
  await expect(page.getByText('#1')).toBeVisible({ timeout: 10_000 });

  // 抽屉：开合并点名（场记 = 左侧在场角色抽屉）
  await page.getByRole('button', { name: '☰ 在场角色' }).click();
  const aliceBtn = page.getByRole('button', { name: /Alice/ }).first();
  await expect(aliceBtn).toBeVisible();
  await aliceBtn.click(); // 点名后抽屉自动收起
  await expect(aliceBtn).toBeHidden();
  // 右侧导演面板抽屉也能开合
  await page.getByRole('button', { name: '导演面板 ☰' }).click();
  await expect(page.getByText('生成控制')).toBeVisible();
  await page.getByRole('button', { name: '收起' }).first().click();

  // 底部发言栏：填提示词 → AI 生成 → 草稿卡出 mock 全文 → 确认 → seq=2 上屏
  await bottomBar.getByPlaceholder(/提示词/).fill('向导演致意');
  await bottomBar.getByRole('button', { name: '生成' }).click();
  await expect(draftCard.getByText(MOCK_TEXT)).toBeVisible({ timeout: 20_000 });
  await draftCard.getByRole('button', { name: '确认落盘' }).click();
  await expect(page.getByText('#2')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(MOCK_TEXT)).toBeVisible();
});
