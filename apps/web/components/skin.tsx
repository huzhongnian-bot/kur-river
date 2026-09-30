// 题材皮肤作用域组件；登记表在 @/lib/skins（API 路由共用，故拆成无 'use client' 模块）。
// 皮肤挂 troupe 级，scene.skin 可单场覆盖。
'use client';

import type { ReactNode } from 'react';
import { DEFAULT_SKIN, normalizeSkin } from '@/lib/skins';

export { DEFAULT_SKIN, normalizeSkin, SKIN_IDS, SKINS } from '@/lib/skins';

/** 会话页皮肤作用域：非默认皮时重铺背景/文字色并挂 data-skin，CSS 变量在作用域内生效 */
export function SkinScope({
  skin,
  className,
  children,
}: {
  skin: string | null | undefined;
  className?: string;
  children: ReactNode;
}) {
  const id = normalizeSkin(skin);
  if (id === DEFAULT_SKIN) {
    return <div className={className}>{children}</div>;
  }
  return (
    <div data-skin={id} className={`min-h-screen bg-background text-foreground ${className ?? ''}`}>
      {children}
    </div>
  );
}
