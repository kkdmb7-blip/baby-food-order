import { NextRequest, NextResponse } from 'next/server';
import { notifyError } from '@/lib/notify';

// POST /api/log-error — 손님 브라우저에서 난 오류를 서버로 모아 텔레그램으로 알림.
// 손님은 오류를 만나면 대개 아무 말 없이 창을 닫기 때문에, 이 경로가 없으면
// 사장님은 "왜 주문이 안 들어오지?" 하고 끝나게 됨.
//
// 공개 엔드포인트라 장난 요청이 들어올 수 있어서 길이 제한 + IP당 호출 제한을 둔다.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, { count: number; first: number }>();

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = hits.get(ip);
  if (rec && now - rec.first < WINDOW_MS) {
    if (rec.count >= MAX_PER_WINDOW) return NextResponse.json({ ok: true, throttled: true });
    rec.count++;
  } else {
    hits.set(ip, { count: 1, first: now });
  }
  if (hits.size > 500) {
    for (const [k, v] of hits) if (now - v.first > WINDOW_MS) hits.delete(k);
  }

  const b = await req.json().catch(() => ({}));
  const message = String(b.message || '').slice(0, 300);
  if (!message) return NextResponse.json({ ok: true });

  await notifyError('client', message, {
    화면: String(b.where || '-').slice(0, 60),
    상세: String(b.stack || '').slice(0, 200) || undefined,
    기기: (req.headers.get('user-agent') || '').slice(0, 120),
  });

  return NextResponse.json({ ok: true });
}
