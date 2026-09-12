// 单用户密码门（DESIGN §3：basic auth 级，自部署也不裸奔）。
// 未设置 APP_PASSWORD 时放行（本地开发便利）；设置后除 /api/health 外
// 所有路由要求 HTTP Basic（用户名任意、密码匹配）。
import { NextRequest, NextResponse } from 'next/server';

export const config = {
  // 公开资源不过门：健康检查 + PWA（manifest/图标不含敏感数据，安装流程需可匿名获取）
  matcher: ['/((?!api/health|manifest.webmanifest|icon.svg|icons/|_next/static|_next/image|favicon.ico).*)'],
};

export default function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const header = req.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice('Basic '.length));
      const sep = decoded.indexOf(':');
      const pwd = sep === -1 ? decoded : decoded.slice(sep + 1);
      if (pwd === password) return NextResponse.next();
    } catch {
      // 非法 base64 按未认证处理
    }
  }

  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="kur-river"' },
  });
}
