// 题材皮肤登记表（无 'use client'，API 路由与组件共用）。
// 新皮肤 = app/skins/ 下加一个 CSS 文件 + 这里登记表加一行。
export interface SkinMeta {
  id: string;
  name: string;
  description: string;
}

export const SKINS: SkinMeta[] = [
  { id: 'modern', name: '现代简约', description: '默认皮肤，管理页与现代都市题材通用' },
  { id: 'parchment', name: '羊皮纸酒馆', description: '西方幻想：做旧纸面、衬线墨色、皮革棕' },
];

export const SKIN_IDS: string[] = SKINS.map((s) => s.id);
export const DEFAULT_SKIN = 'modern';

export function normalizeSkin(skin: string | null | undefined): string {
  return skin && SKIN_IDS.includes(skin) ? skin : DEFAULT_SKIN;
}
