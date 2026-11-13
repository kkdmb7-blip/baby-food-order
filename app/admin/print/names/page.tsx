import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, type Order } from '@/lib/supabase';
import { kstToday } from '@/lib/dates';
import { orderDates, shiftDate, disambiguateNames } from '@/lib/orderItems';
import NameTagSheet, { type Tag } from './NameTagSheet';

export const dynamic = 'force-dynamic';

/*
  이름표 — 포장한 봉투에 잘라 붙이는 이름 칸 (2026-11-13)

  사장님: "이름표 프린트도 할 수 있게 만들어줘 지금 크기 감안해서 그거 잘라서 포장 후 붙이거든"

  엑셀 '이유식이름' 시트를 그대로 옮겼다:
    A4 세로, 여백 0, 가운데 정렬, 90% 배율
    칸 너비 22.75(≈43.4mm) × 높이 61.15pt(≈21.6mm) → 90%면 39mm × 19.4mm
    가로 5칸 × 세로 14칸 = 한 장 70칸, 맑은 고딕 26pt(→ 23.4pt), 칸 테두리 점선(자르는 선)

  들어가는 이름
    그날 조리하는 주문 전부(배송·픽업·택배 가리지 않음 — 봉투는 다 붙인다)
    + '적어둔 이름'(baby_food_pending_names, 수량 없이 이름만 적어 둔 늦은 주문)
    + 화면에서 직접 적어 넣은 이름
*/
export default async function NamesPage({ searchParams }: { searchParams: { date?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date || '') ? searchParams.date! : kstToday();

  const sb = supabaseService();
  const [{ data }, { data: pend }] = await Promise.all([
    sb.from('baby_food_orders').select('*')
      .gte('delivery_date', shiftDate(date, -21)).lte('delivery_date', shiftDate(date, 21))
      .neq('status', '취소').order('baby_name').limit(1000),
    sb.from('baby_food_pending_names').select('id, baby_name, done_at').eq('delivery_date', date).limit(200),
  ]);
  const orders: Order[] = (data || []).filter(o => orderDates(o as any).includes(date));
  const disp = disambiguateNames(orders as any);

  const tags: Tag[] = orders.map(o => ({
    key: o.id,
    name: disp.get(o.id) || o.baby_name,
    kind: String(o.stage || '').startsWith('반찬') ? '반찬' : '이유식',
    pickup: (o as any).receive_method === '픽업',
    parcel: o.delivery_method === '택배익일배송',
  }));
  const have = new Set(tags.map(t => t.name.replace(/\d+$/, '')));
  for (const p of pend || []) {
    const n = String(p.baby_name || '').trim();
    if (!n || have.has(n)) continue; // 이미 주문이 들어온 이름은 두 번 뽑지 않는다
    tags.push({ key: 'p:' + p.id, name: n, kind: '적어둔 이름', pickup: false, parcel: false });
  }
  tags.sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  return <NameTagSheet date={date} tags={tags} />;
}
