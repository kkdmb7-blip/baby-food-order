import { NextRequest, NextResponse } from 'next/server';
import { setAdminSession, clearAdminSession } from '@/lib/auth';

// POST /api/auth — body { password }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const password = String(body.password || '');
  const expected = process.env.ADMIN_PASSWORD || '';

  // 단순 평문 비교 + 길이 일정 비교 (timing attack 미세하게 방지)
  if (!expected || password.length === 0 || password !== expected) {
    return NextResponse.json({ ok: false, error: '비밀번호가 일치하지 않습니다' }, { status: 401 });
  }
  setAdminSession();
  return NextResponse.json({ ok: true });
}

// DELETE /api/auth — 로그아웃
export async function DELETE() {
  clearAdminSession();
  return NextResponse.json({ ok: true });
}
