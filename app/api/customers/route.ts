import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, PREPAID_UNITS } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';

// GET /api/customers — 고객 목록 (admin)
//
// ?q= 로 이름·번호를 찾는다. 손님은 계속 쌓이는데 PostgREST 는 1000행에서 조용히 자르므로,
// 전부 받아다 화면에서 거르면 그 뒤 손님은 검색해도 안 나온다(에러도 없이).
// 찾는 일은 서버에서 한다.
export async function GET(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = supabaseService();
  const q = (req.nextUrl.searchParams.get('q') || '').trim().slice(0, 40);

  let query = sb.from('baby_food_customers').select('*');
  if (q) {
    // ilike 특수문자(% _ ,)가 들어오면 패턴이 깨지거나 or() 구문이 쪼개진다
    const safe = q.replace(/[%_,()]/g, '');
    if (!safe) return NextResponse.json({ customers: [] });
    const digits = safe.replace(/\D/g, '');
    const conds = [`baby_name.ilike.%${safe}%`];
    if (digits.length >= 2) conds.push(`phone.ilike.%${digits}%`);
    query = query.or(conds.join(',')).order('baby_name').limit(80);
  } else {
    query = query.or('prepaid_balance.gt.0,is_regular.eq.true').order('baby_name').limit(1000);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ customers: data });
}

// PATCH /api/customers — 아기 이름만 고친다 (admin)
//
// 조리표에 찍히는 이름은 카카오 채널에 저장해 둔 이름과 같아야 한다. 주문이 카톡으로
// 오니까, 종이의 이름이 카톡 이름과 다르면 누구 주문인지 맞춰볼 수가 없다.
// 동명이인은 사장님이 카톡에 '찬희2', '찬희3' 으로 저장해 두시므로 앱도 그대로 따라간다.
//
// ⚠️ 이름은 주문 행에도 따로 저장돼 있다(baby_food_orders.baby_name). 고객 쪽만 고치면
// 조리표는 옛 이름을 계속 찍는다 — 조리표가 읽는 건 주문이기 때문이다. 그래서 같은
// 연락처의 주문 이름도 함께 바꾼다. "이 집 이름은 찬희2" 가 한 번에 맞춰져야 한다.
export async function PATCH(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const id = String(b.id || '');
  const baby_name = String(b.baby_name || '').trim().slice(0, 20);
  if (!id || !baby_name) return NextResponse.json({ error: '이름이 비었어요' }, { status: 400 });

  const sb = supabaseService();
  const { data: cur, error: readErr } = await sb
    .from('baby_food_customers').select('id, phone, baby_name').eq('id', id).single();
  if (readErr || !cur) return NextResponse.json({ error: '고객을 찾지 못했어요' }, { status: 404 });

  const { error } = await sb.from('baby_food_customers').update({ baby_name }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 주문 쪽도 맞춘다. 실패해도 고객 이름은 이미 바뀌었으니 몇 건이 안 바뀌었는지 알려준다.
  let ordersUpdated = 0;
  let ordersError: string | null = null;
  const phone = String(cur.phone || '').replace(/\D/g, '');
  if (phone) {
    const { data: rows, error: oErr } = await sb
      .from('baby_food_orders').update({ baby_name })
      .eq('customer_phone', phone).select('id');
    if (oErr) ordersError = oErr.message;
    else ordersUpdated = rows?.length || 0;
  }

  return NextResponse.json({ ok: true, baby_name, was: cur.baby_name, ordersUpdated, ordersError });
}

// POST /api/customers — 고객 등록/수정 (admin)
export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const { id, baby_name, phone, is_regular, regular_schedule, memo } = b;
  if (!baby_name || !phone) return NextResponse.json({ error: '이름·연락처 필수' }, { status: 400 });

  const sb = supabaseService();
  // ⚠️ regular_schedule을 무조건 덮어쓰면(예전엔 `|| []`), 이름·메모만 고치려고 호출해도
  // 그 고객의 정기배송 스케줄이 통째로 날아가고 cron이 조용히 그 고객을 건너뛰게 됨.
  // 값을 명시적으로 보냈을 때만 갱신한다. 형식도 배열이 아니라 객체({stage,volume,slots})가 맞음.
  const row: Record<string, any> = {
    baby_name, phone: String(phone).replace(/\D/g, ''), is_regular: !!is_regular, memo: memo || null,
  };
  if (regular_schedule !== undefined) row.regular_schedule = regular_schedule || {};
  const { data, error } = id
    ? await sb.from('baby_food_customers').update(row).eq('id', id).select('id').single()
    : await sb.from('baby_food_customers').insert(row).select('id').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data?.id });
}
