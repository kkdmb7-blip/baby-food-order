import { NextRequest, NextResponse } from 'next/server';
import { formatPhone } from '@/lib/dates';

export async function POST(req: NextRequest) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ADMIN_EMAIL;
  const from = process.env.NOTIFY_FROM_EMAIL || 'onboarding@resend.dev';
  if (!apiKey || !to) return NextResponse.json({ ok: true, skipped: true });

  const b = await req.json().catch(() => ({}));
  const text = [
    `[새 주문]`,
    `아기: ${b.baby_name || '-'}`,
    `단계·용량: ${b.stage || '-'} · ${b.volume || '-'}g`,
    `총: ${b.total_qty || 0}팩 / ${(b.total_price || 0).toLocaleString()}원`,
    `조리일: ${b.delivery_date || '-'}`,
    `주소: ${b.address || '-'}`,
    `연락처: ${formatPhone(b.customer_phone || '')}`,
    `주문ID: ${b.id || ''}`
  ].join('\n');

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [to],
        subject: `[이유식 주문] ${b.baby_name || '주문자'} · ${b.stage || ''} ${b.total_qty || ''}팩`,
        text
      })
    });
  } catch (e) { console.error('[notify]', e); }
  return NextResponse.json({ ok: true });
}
