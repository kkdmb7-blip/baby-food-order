import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';

/*
  적어둔 이름 — 조리일별 '이름만' 메모 (baby_food_pending_names)

  왜 필요한가
    한 손님이 월요일과 목요일을 한 번에 주문하신다. 그런데 월요일 것을 정리하면서
    목요일 것까지 같이 치면 시간이 너무 걸린다. 그래서 사장님은 목요일 자리에
    이름만 적어두고, 목요일을 정리할 때 카톡을 다시 보며 그때 채워 넣으신다.
    엑셀에서는 다음 날짜 칸에 이름만 적어두면 됐는데, 앱에는 그 자리가 없었다.

  주문이 아니다
    팩수도 메뉴도 없는 '할 일'이다. 주문 표에 넣으면 조리표·주소록·매출에
    0팩 주문이 섞인다. 그래서 따로 둔다.

  처리되면 지우지 않고 done_at 만 찍는다
    실수로 지웠을 때 되살릴 수 있어야 하고, 그날 무엇을 적어뒀었는지도 남는다.
*/

export const dynamic = 'force-dynamic';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * GET ?date=YYYY-MM-DD        그 날짜만
 * GET ?from=…&to=…            기간 (요일 체크판이 한 주를 한 번에 받는다)
 */
export async function GET(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const date = (sp.get('date') || '').trim();
  const from = (sp.get('from') || '').trim();
  const to = (sp.get('to') || '').trim();

  const sb = supabaseService();
  let q = sb
    .from('baby_food_pending_names')
    .select('id, delivery_date, baby_name, customer_phone, note, done_at, created_at')
    .order('created_at', { ascending: true })
    .limit(500);

  if (DATE.test(from) && DATE.test(to)) q = q.gte('delivery_date', from).lte('delivery_date', to);
  else if (DATE.test(date)) q = q.eq('delivery_date', date);
  else return NextResponse.json({ error: 'invalid date' }, { status: 400 });

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, rows: data || [] });
}

export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));

  const delivery_date = String(b.delivery_date || '').trim();
  const baby_name = String(b.baby_name || '').trim().slice(0, 20);
  if (!DATE.test(delivery_date)) return NextResponse.json({ error: '조리일을 골라주세요' }, { status: 400 });
  if (!baby_name) return NextResponse.json({ error: '이름을 넣어주세요' }, { status: 400 });

  const phone = String(b.customer_phone || '').replace(/\D/g, '');
  const sb = supabaseService();
  const { data, error } = await sb
    .from('baby_food_pending_names')
    .insert({
      delivery_date,
      baby_name,
      customer_phone: phone || null,
      note: String(b.note || '').trim().slice(0, 100) || null,
    })
    .select('id, delivery_date, baby_name, customer_phone, note, done_at, created_at')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, row: data });
}

/** 처리됨 표시(또는 되돌리기). body: { id, done: boolean } */
export async function PATCH(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const id = String(b.id || '');
  if (!UUID.test(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const sb = supabaseService();
  const { error } = await sb
    .from('baby_food_pending_names')
    .update({ done_at: b.done === false ? null : new Date().toISOString() })
    .eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const id = (req.nextUrl.searchParams.get('id') || '').trim();
  if (!UUID.test(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const sb = supabaseService();
  const { error } = await sb.from('baby_food_pending_names').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
