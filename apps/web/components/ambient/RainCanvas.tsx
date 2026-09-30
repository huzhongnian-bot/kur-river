'use client';

import { useEffect, useRef } from 'react';

interface Drop {
  x: number;
  y: number;
  len: number;
  speed: number;
}

/** 雨丝粒子：固定定位 canvas，铺满视口，不响应指针 */
export function RainCanvas({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let drops: Drop[] = [];
    let raf = 0;

    function resize() {
      if (!canvas) return;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      const count = Math.floor((window.innerWidth * window.innerHeight) / 9000);
      drops = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        len: (10 + Math.random() * 14) * dpr,
        speed: (9 + Math.random() * 6) * dpr,
      }));
    }

    function tick() {
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = 'rgba(120, 140, 170, 0.35)';
      ctx.lineWidth = dpr;
      ctx.beginPath();
      for (const d of drops) {
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.len * 0.15, d.y + d.len);
        d.y += d.speed;
        d.x -= d.speed * 0.15;
        if (d.y > canvas.height) {
          d.y = -d.len;
          d.x = Math.random() * (canvas.width + 100 * dpr);
        }
      }
      ctx.stroke();
      raf = requestAnimationFrame(tick);
    }

    resize();
    tick();
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className={className} />;
}
