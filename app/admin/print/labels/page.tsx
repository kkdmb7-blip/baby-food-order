import React from 'react';
import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, type Order } from '@/lib/supabase';
import { kstToday, formatPhone } from '@/lib/dates';
import { orderDates, qtyOn, shiftDate } from '@/lib/orderItems';
import PrintAuto from '../PrintAuto';
import PrintBar from '../PrintBar';

export const dynamic = 'force-dynamic';

const DOW_KOR = ['일', '월', '화', '수', '목', '금', '토'];

// 사장님이 직접 도는 배송만 인쇄 — 택배(익일)는 포장해서 접수하는 거라 주소록에 필요 없음
function isDrivenByUs(o: Order): boolean {
  const m = o.delivery_method;
  if (m === '택배익일배송') return false;
  if (m === '직배송' || m === '당일배송') return true;
  // delivery_method가 없던 예전 주문은 주소로 추정
  return /강서|양천/.test(`${o.address || ''} ${o.address_detail || ''}`);
}

// 동네 묶음은 "구" 단위 — 손님이 "강서구화곡동"처럼 붙여 쓰기도 해서 동까지 키로 잡으면
// 같은 동네가 갈라짐. 구로 묶고 그 안에서 주소순 정렬하면 같은 동끼리 붙는다.
function areaOf(o: Order): string {
  const addr = String(o.address || '').replace(/^(서울특별시|서울시|서울)\s*/, '').trim();
  const gu = addr.match(/([가-힣]+구)/)?.[1];
  if (gu) return gu;
  return o.zone_group ? String(o.zone_group) : '기타';
}
function dongOf(o: Order): string {
  const addr = String(o.address || '').replace(/^(서울특별시|서울시|서울)\s*/, '').trim();
  const gu = addr.match(/([가-힣]+구)/)?.[1] || '';
  const rest = gu ? addr.slice(addr.indexOf(gu) + gu.length) : addr;
  return rest.match(/([가-힣]+[동읍면])/)?.[1] || '';
}
// "없음", "-" 같이 의미 없는 값은 지면만 차지하므로 표시하지 않음
function doorPw(o: Order): string {
  const v = String(o.door_password || '').trim();
  if (!v || /^(없음|없어요|없습니다|-|없)$/.test(v)) return '';
  return v;
}

export default async function LabelsPage({ searchParams }: { searchParams: { date?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');
  const date = searchParams.date || kstToday();

  const sb = supabaseService();
  const { data } = await sb.from('baby_food_orders').select('*')
    .gte('delivery_date', shiftDate(date, -21))
    .lte('delivery_date', shiftDate(date, 21))
    .neq('status', '취소').order('baby_name').limit(500);
  const all: Order[] = (data || []).filter(o => orderDates(o as any).includes(date));
  const orders = all.filter(isDrivenByUs);
  const parcelCount = all.length - orders.length;

  const groups = new Map<string, Order[]>();
  for (const o of orders) {
    const k = areaOf(o);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(o);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.address || '').localeCompare(String(b.address || '')));
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const dow = DOW_KOR[new Date(date + 'T00:00:00Z').getUTCDay()];
  let no = 0;

  return (
    <div className="bg-white min-h-screen p-3 text-black print:p-0">
      <PrintAuto />
      <style>{`@media print { @page { size: A4; margin: 8mm; } }`}</style>

      <div className="flex justify-between items-baseline mb-1.5 border-b border-black pb-1">
        <div className="flex items-baseline gap-2 text-[12px]">
          <span className="text-base font-black">배송 {date} ({dow})</span>
          <span className="font-bold">{orders.length}건</span>
          {parcelCount > 0 && <span className="text-stone-500">택배 {parcelCount}건 제외</span>}
        </div>
        <PrintBar date={date} kind="labels" />
      </div>

      <table className="w-full border-collapse text-[12px] leading-tight">
        <tbody>
          {sorted.map(([area, list]) => (
            <React.Fragment key={area}>
              <tr>
                <td colSpan={5} className="border-b border-black pt-1.5 pb-0.5 font-black text-[11px]">
                  {area} <span className="font-normal text-stone-500">{list.length}건</span>
                </td>
              </tr>
              {list.map(o => {
                no++;
                return (
                  <tr key={o.id} className="border-b border-stone-300">
                    <td className="py-[3px] pr-1 w-4 align-top text-stone-400 text-[10px]">{no}</td>
                    <td className="py-[3px] pr-1.5 w-[58px] align-top font-bold whitespace-nowrap">{o.baby_name}</td>
                    <td className="py-[3px] pr-1.5 align-top">
                      {dongOf(o) && <span className="font-bold">[{dongOf(o)}] </span>}
                      {o.address}
                      {o.address_detail && <span className="font-bold"> {o.address_detail}</span>}
                      {doorPw(o) && <span className="text-[11px] text-stone-600"> 🔑{doorPw(o)}</span>}
                    </td>
                    <td className="py-[3px] pr-1 align-top text-right whitespace-nowrap">{formatPhone(o.customer_phone)}</td>
                    <td className="py-[3px] align-top text-right whitespace-nowrap font-bold w-8">{qtyOn(o as any, date)}팩</td>
                  </tr>
                );
              })}
            </React.Fragment>
          ))}
        </tbody>
      </table>

      {orders.length === 0 && (
        <div className="py-10 text-center text-stone-400 text-sm">
          {parcelCount > 0 ? `택배 ${parcelCount}건만 있어요 (직접 배송 없음)` : '배송할 주문이 없습니다'}
        </div>
      )}
    </div>
  );
}
