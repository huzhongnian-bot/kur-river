// M1 冒烟：带密码门走通"单人戏" UI 闭环（DESIGN §8 M1 验收）。
// 基建（mock LLM / 独立测试库 / next start）由 global-setup 拉起，见 infra.ts。
//
// 两点环境说明（探测结论，非应用缺陷）：
// - 密码门 401 用 node 裸 fetch 验证：playwright 的 request 上下文会继承
//   config 的 httpCredentials，测不了"无凭证"。
// - 页面间导航用 page.goto（document 加载）：本机 Playwright Chromium 的
//   客户端 RSC 导航偶发 net::ERR_ABORTED / ERR_INSUFFICIENT_RESOURCES
//   （服务器 curl 直连 8ms 响应、文档加载与 API 交互均正常），
//   Link 点击跳转未经浏览器验证。
import { expect, test, type Page } from '@playwright/test';
import { MOCK_TEXT } from './infra';

const webBase = process.env.SMOKE_WEB_BASE!;
const mockBase = process.env.SMOKE_MOCK_BASE!;

/** 按 label 文本找其紧邻的兄弟控件（本仓库 label 与控件无 for/包裹关联） */
function field(page: Page, label: string | RegExp, kind: 'input' | 'textarea' | 'select' = 'input') {
  return page
    .locator('label', { hasText: label })
    .first()
    .locator(`xpath=following-sibling::${kind}[1]`);
}

test('密码门：无凭证 401（含 WWW-Authenticate），/api/health 公开', async () => {
  const raw = await fetch(`${webBase}/`);
  expect(raw.status).toBe(401);
  expect(raw.headers.get('www-authenticate')).toBe('Basic realm="kur-river"');
  const wrong = await fetch(`${webBase}/`, {
    headers: { authorization: `Basic ${Buffer.from('x:wrong').toString('base64')}` },
  });
  expect(wrong.status).toBe(401);
  expect((await fetch(`${webBase}/api/health`)).status).toBe(200);
});

test('M1 单人戏 UI 闭环：建世界 → 开场确认 → 指令生成 → 确认上屏', async ({ page }) => {
  // ---- 世界书 ------------------------------------------------------------
  await page.goto(`${webBase}/worlds`);
  await page.getByPlaceholder('标题（必填）').fill('冒烟世界');
  await page.getByPlaceholder('世界观前提设定（可空）').fill('雪夜边境。');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  const worldHref = await page.getByRole('link', { name: '冒烟世界' }).getAttribute('href');
  expect(worldHref).toMatch(/^\/worlds\//);
  await page.goto(`${webBase}${worldHref}`);

  // ---- 角色（first_mes 带宏） --------------------------------------------
  await page.getByRole('button', { name: '新建角色' }).click();
  await field(page, /^角色名/).fill('Alice');
  await field(page, /first_mes/, 'textarea').fill('*亮相* 「{{user}}，好戏开场。」—— {{char}} 敬上。');
  await field(page, /卡 · description/, 'textarea').fill('银发剑士。');
  await page.getByRole('button', { name: '创建角色' }).click();
  await expect(page.getByText('talkativeness 0.5')).toBeVisible();

  // ---- 化身 / 团队 --------------------------------------------------------
  await page.getByPlaceholder('化身名 *').fill('导演');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await expect(page.getByText('导演').first()).toBeVisible();

  await page.getByPlaceholder('团队名 *').fill('冒烟团');
  await page.getByRole('combobox').selectOption({ label: '导演' });
  await page.getByRole('button', { name: '新建团队' }).click();
  const troupeHref = await page.getByRole('link', { name: '冒烟团' }).getAttribute('href');
  expect(troupeHref).toMatch(/^\/troupes\//);
  await page.goto(`${webBase}${troupeHref}`);

  // ---- 成员 / 场次 ---------------------------------------------------------
  await page.locator('select', { hasText: '从角色池选角' }).selectOption({ label: 'Alice' });
  await page.getByRole('button', { name: '加入' }).click();
  await page.getByRole('checkbox', { name: 'Alice' }).check();
  await page.getByRole('button', { name: '新建场次' }).click();
  const sessionHref = await page.getByRole('link', { name: '（无标题场次）' }).getAttribute('href');
  expect(sessionHref).toMatch(/^\/sessions\//);
  await page.goto(`${webBase}${sessionHref}`);

  // ---- 开场草稿（§5.2.2）：宏已替换 → 确认落盘 seq=1 -----------------------
  const draftCard = page.getByTestId('draft-card');
  await expect(draftCard.getByText('草稿 · Alice')).toBeVisible();
  // 阅读流：宏替换后的内容直接可读；点击段落 → 行内编辑器
  await expect(draftCard.getByText(/导演，好戏开场/)).toBeVisible();
  await expect(draftCard.getByText(/Alice 敬上/)).toBeVisible();
  await draftCard.getByText(/导演，好戏开场/).click();
  await expect(draftCard.locator('textarea')).toHaveValue(/导演，好戏开场/);
  await draftCard.getByRole('button', { name: '完成' }).click();
  const sessionUrl = page.url();
  await draftCard.getByRole('button', { name: '确认落盘' }).click();
  await expect(page.getByText('#1')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/导演，好戏开场/)).toBeVisible();

  // ---- LLM 设置：连接（指向 mock）→ 拉模型 → 全局默认 ----------------------
  await page.goto(`${webBase}/settings/providers`);
  await field(page, /^名称 \*/).fill('mock');
  await field(page, /baseUrl/).fill(mockBase);
  await field(page, '默认模型（可空）').fill('mock-model');
  await page.getByRole('button', { name: '新建连接' }).click();
  await page.getByRole('button', { name: '拉取模型列表' }).click();
  await expect(page.getByRole('button', { name: 'mock-model', exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await field(page, '默认连接', 'select').selectOption({ label: 'mock' });
  await page.getByRole('button', { name: '保存全局默认' }).click();
  await expect(page.getByText('全局默认已保存')).toBeVisible();

  // ---- 回到演出界面：底部发言栏输入提示词 → AI 生成（走全局默认连接）→ 确认 seq=2 ----
  await page.goto(sessionUrl);
  await page.getByPlaceholder(/提示词/).fill('让 {{char}} 向 {{user}} 致意');
  await page.getByRole('button', { name: '✨ 生成' }).click();
  await expect(draftCard.getByText('草稿 · Alice')).toBeVisible();
  await expect(draftCard.getByText(MOCK_TEXT)).toBeVisible({ timeout: 20_000 });
  await draftCard.getByRole('button', { name: '确认落盘' }).click();
  await expect(page.getByText('#2')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(MOCK_TEXT)).toBeVisible();

  // ---- 消息操作：编辑 / 改提示词重演 / 删除 --------------------------------
  const cardOf = (seq: string) =>
    page.getByTestId('message-card').filter({
      has: page.getByText(seq, { exact: true }),
    });

  // 编辑：段落文本改写 → 保存 → 上屏内容更新
  await cardOf('#2').getByRole('button', { name: '编辑' }).click();
  await cardOf('#2').locator('textarea').first().fill('改过的话：雪落有声。');
  await cardOf('#2').getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByText('改过的话：雪落有声。')).toBeVisible({ timeout: 10_000 });

  // 改提示词重演：预填原提示词（草稿留痕）→ 换新提示词 → 重演 → 确认后重新上屏
  await cardOf('#2').getByRole('button', { name: '改提示词重演' }).click();
  const replayBox = cardOf('#2').locator('textarea');
  await expect(replayBox).toHaveValue(/致意/); // 预填了生成该条时用的提示词
  await replayBox.fill('换个版本');
  await cardOf('#2').getByRole('button', { name: '重演生成' }).click();
  await expect(draftCard.getByText('草稿 · Alice')).toBeVisible();
  await expect(draftCard.getByText(MOCK_TEXT)).toBeVisible({ timeout: 20_000 });
  await draftCard.getByRole('button', { name: '确认落盘' }).click();
  await expect(cardOf('#2').getByText(MOCK_TEXT)).toBeVisible({ timeout: 10_000 });

  // 删除：确认对话框 → 消息下屏
  page.on('dialog', (d) => void d.accept());
  await cardOf('#2').getByRole('button', { name: '删除' }).click();
  await expect(page.getByText('#2', { exact: true })).toBeHidden({ timeout: 10_000 });
});
