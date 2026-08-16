import { NextRequest, NextResponse } from 'next/server';
import { formatPhone } from '@/lib/dates';

export async function POST(req: NextRequest) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ADMIN_EMAIL;
  const from = process.env.NOTIFY_FROM_EMAIL || 'onboarding@resend.dev';
  if (!apiKey || !to) return NextResponse.json({ ok: true, skipped: true });

  const b = await req.json().catch(() => ({}));

  // 복합주문은 stage='mixed', volume=null이라 예전엔 "mixed · -g"라는 알 수 없는 메일이 왔음 —
  // 날짜별 구성을 그대로 풀어서 보여준다.
  const items: any[] = Array.isArray(b.items) ? b.items : [];
  const isMulti = items.length > 0 && items[0]?.delivery_date !== undefined;
  const detail = isMulti
    ? items.map(d => {
        const sets = (d.sets || []).map((s: any) => {
          const menus = (s.menus || []).filter((m: any) => m.qty > 0).map((m: any) => `${m.menu} ${m.qty}`).join('·');
          const label = s.stage === '반찬세트' ? '반찬세트' : `${s.stage} ${s.volume}g`;
          return `${label} ${s.qty}${s.stage === '반찬세트' ? '세트' : '팩'}${menus ? ` (${menus})` : ''}`;
        }).join(' / ');
        return `  · ${d.delivery_date}: ${sets || '-'} = ${d.date_qty || 0}팩`;
      }).join('\n')
    : `  · ${b.stage || '-'} ${b.volume ? b.volume + 'g' : ''} ${b.total_qty || 0}팩`;

  const dates = isMulti
    ? [...new Set(items.map(d => d.delivery_date).filter(Boolean))].sort().join(', ')
    : (b.delivery_date || '-');

  const text = [
    `[새 주문]`,
    `아기: ${b.baby_name || '-'}`,
    `조리일: ${dates}`,
    `구성:`,
    detail,
    `총: ${b.total_qty || 0}팩 / ${(b.total_price || 0).toLocaleString()}원`,
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
