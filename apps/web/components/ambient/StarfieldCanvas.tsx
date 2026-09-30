'use client';

import { useEffect, useRef } from 'react';

interface Star {
  x: number;
  y: number;
  r: number;
  phase: number;
  twinkle: number;
}

/** 星空：静止星点 + 各自相位闪烁 + 整体极慢漂移 */
export function StarfieldCanvas({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let stars: Star[] = [];
    let raf = 0;

    function resize() {
      if (!canvas) return;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      const count = Math.floor((window.innerWidth * window.innerHeight) / 4500);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: (0.4 + Math.random() * 1.1) * dpr,
        phase: Math.random() * Math.PI * 2,
        twinkle: 0.4 + Math.random() * 1.2,
      }));
    }

    function tick(t: number) {
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const drift = (t / 1000) * 2 * dpr; // 极慢横向漂移
      for (const s of stars) {
        const alpha = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(s.phase + (t / 1000) * s.twinkle));
        const x = (s.x + drift) % canvas.width;
        ctx.beginPath();
        ctx.arc(x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(230, 238, 255, ${alpha.toFixed(3)})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    }

    resize();
    raf = requestAnimationFrame(tick);
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className={className} />;
}
