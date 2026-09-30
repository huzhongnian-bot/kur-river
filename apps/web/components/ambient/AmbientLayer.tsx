// 氛围动画层（DESIGN：氛围挂 session 级，数据在 sessions.scene.ambience）。
// 形如 scene.ambience = { weather: 'rain' | 'stars', time?: 'night' | … }。
// 尊重 prefers-reduced-motion：命中时整层不渲染。
'use client';

import { useEffect, useState } from 'react';
import { RainCanvas } from './RainCanvas';
import { StarfieldCanvas } from './StarfieldCanvas';

export interface Ambience {
  weather?: string;
  time?: string;
}

/** 从 session.scene（unknown）安全提取 ambience 对象 */
export function readAmbience(scene: unknown): Ambience | null {
  if (!scene || typeof scene !== 'object') return null;
  const a = (scene as Record<string, unknown>).ambience;
  if (!a || typeof a !== 'object') return null;
  return a as Ambience;
}

const CANVAS_CLS = 'pointer-events-none fixed inset-0 z-0 h-full w-full';

export function AmbientLayer({ ambience }: { ambience: Ambience | null }) {
  const [reduced, setReduced] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  if (reduced || !ambience?.weather) return null;

  switch (ambience.weather) {
    case 'rain':
      return <RainCanvas className={CANVAS_CLS} />;
    case 'stars':
      return <StarfieldCanvas className={CANVAS_CLS} />;
    default:
      return null;
  }
}
