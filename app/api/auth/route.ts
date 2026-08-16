import { NextRequest, NextResponse } from 'next/server';
import { setAdminSession, clearAdminSession } from '@/lib/auth';
import { timingSafeEqual } from 'crypto';

// 관리자 비밀번호는 숫자 위주라 무제한으로 시도하면 언젠가 뚫린다 —
// IP당 시도 횟수를 제한해서 자동 대입을 막는다. (서버 인스턴스 메모리 기준의 가벼운 방어)
const WINDOW_MS = 10 * 60 * 1000; // 10분
const MAX_TRIES = 8;
const attempts = new Map<string, { count: number; first: number }>();

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

// 비교 시간이 입력값에 따라 달라지지 않게 고정 — 예전 주석은 "timing attack 방지"라고
// 적혀 있었지만 실제로는 `!==` 단순 비교라 방어가 되지 않았음.
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // 길이가 달라도 비교 시간을 비슷하게 유지
    try { timingSafeEqual(ba, ba); } catch {}
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// POST /api/auth — body { password }
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec && now - rec.first < WINDOW_MS && rec.count >= MAX_TRIES) {
    const waitMin = Math.ceil((WINDOW_MS - (now - rec.first)) / 60000);
    return NextResponse.json(
      { ok: false, error: `시도가 너무 많아요. ${waitMin}분 후 다시 시도해주세요` },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const password = String(body.password || '');
  const expected = process.env.ADMIN_PASSWORD || '';

  if (!expected || password.length === 0 || !safeEqual(password, expected)) {
    if (!rec || now - rec.first >= WINDOW_MS) attempts.set(ip, { count: 1, first: now });
    else rec.count++;
    return NextResponse.json({ ok: false, error: '비밀번호가 일치하지 않습니다' }, { status: 401 });
  }

  attempts.delete(ip); // 성공하면 카운터 초기화
  setAdminSession();
  return NextResponse.json({ ok: true });
}

// DELETE /api/auth — 로그아웃
export async function DELETE() {
  clearAdminSession();
  return NextResponse.json({ ok: true });
}
