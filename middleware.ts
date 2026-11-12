import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from './lib/sessionToken';

// /admin/* 진입 전 쿠키 확인 — 미인증 시 /admin/login 으로
// (페이지 컴포넌트의 isAdminAuthed() 와 이중 방어)
// ⚠️ 전에는 쿠키 값이 '1' 인지만 봤다 — 손으로 적으면 들어가졌다. 이제 서명을 확인한다.
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/admin/login') return NextResponse.next();
  if (pathname.startsWith('/admin')) {
    const ok = await verifySessionToken(
      req.cookies.get('admin_session')?.value, process.env.ADMIN_PASSWORD || '',
    );
    if (!ok) {
      const url = req.nextUrl.clone();
      url.pathname = '/admin/login';
      return NextResponse.redirect(url);
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*']
};
