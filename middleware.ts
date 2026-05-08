import { NextRequest, NextResponse } from 'next/server';

// /admin/* 진입 전 쿠키 확인 — 미인증 시 /admin/login 으로
// (페이지 컴포넌트의 isAdminAuthed() 와 이중 방어)
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/admin/login') return NextResponse.next();
  if (pathname.startsWith('/admin')) {
    const authed = req.cookies.get('admin_session')?.value === '1';
    if (!authed) {
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
