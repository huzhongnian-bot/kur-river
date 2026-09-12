// 公开健康检查（不过密码门，见 middleware.ts 的 matcher）
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ ok: true });
}
