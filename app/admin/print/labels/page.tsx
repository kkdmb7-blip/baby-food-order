import React from 'react';
import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, type Order } from '@/lib/supabase';
import { kstToday, formatPhone } from '@/lib/dates';
import { orderDates, qtyOn, shiftDate } from '@/lib/orderItems';
import { routeCodeOf, addrKey } from '@/lib/routeCode';
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

// 동네 묶음 — 동 단위로 세분화. 손님이 "강서구화곡동"처럼 붙여 쓰는 경우가 있어서
// 구를 먼저 떼어낸 뒤 동을 찾아야 "강서구"와 "강서구 화곡동"으로 갈라지지 않는다.
// 도로명주소(예: 강서구 화곡로 12)에는 동이 아예 없으므로 그때는 도로명으로 묶는다
// — 같은 길이면 사실상 같은 동네라 배송 동선 기준으로도 맞음.
function splitAddr(o: Order) {
  const addr = String(o.address || '').replace(/^(서울특별시|서울시|서울|경기도|인천광역시|부산광역시)\s*/, '').trim();
  const gu = addr.match(/([가-힣]+[구군시])/)?.[1] || '';
  const rest = gu ? addr.slice(addr.indexOf(gu) + gu.length) : addr;
  // "목동로"의 '목동'을 동으로 오인하면 안 되므로 뒤에 로/길이 오는 경우는 제외
  const dong = rest.match(/([가-힣]+[0-9]*[동읍면리])(?![로길])/)?.[1] || '';
  // "곰달래로35길"은 "곰달래로"로 묶어야 같은 길이 흩어지지 않음 (로/대로 우선, 없으면 길)
  const road = rest.match(/([가-힣]+(?:대로|로))/)?.[1]
    || rest.match(/([가-힣0-9]+길)/)?.[1] || '';
  return { gu, dong, road };
}
// 묶음·정렬 기준은 사장님이 엑셀에 매겨둔 배송 순번(routeCode).
// 순번을 못 찾은 새 손님만 주소에서 동/도로명을 뽑아 묶고 맨 뒤로 보낸다.
function areaLabel(o: Order): string {
  const { gu, dong, road } = splitAddr(o);
  if (dong) return [gu, dong].filter(Boolean).join(' ');
  if (road) return [gu, road].filter(Boolean).join(' ');
  return gu || (o.zone_group ? String(o.zone_group) : '기타');
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

  // 사장님이 직접 지정·수정한 순번이 있으면 그게 우선 (엑셀 기본 매핑보다 위)
  const { data: overrideRows } = await sb.from('baby_food_route_codes').select('addr_key, code');
  const overrides = new Map<string, number>();
  (overrideRows || []).forEach((r: any) => overrides.set(r.addr_key, Number(r.code)));
  const codeOf = (o: Order): number | null => {
    const k = addrKey(String(o.address || ''));
    if (k && overrides.has(k)) return overrides.get(k)!;
    return routeCodeOf(String(o.address || ''));
  };

  // 배송 순번(엑셀 전체주소록의 맨 오른쪽 숫자)으로 묶고 정렬 — 인쇄물이 곧 도는 순서가 됨
  type Grp = { code: number | null; label: string; list: Order[] };
  const grpMap = new Map<string, Grp>();
  let matched = 0;
  for (const o of orders) {
    const code = codeOf(o);
    if (code !== null) matched++;
    const key = code !== null ? `c${code}` : `x${areaLabel(o)}`;
    if (!grpMap.has(key)) grpMap.set(key, { code, label: areaLabel(o), list: [] });
    grpMap.get(key)!.list.push(o);
  }
  for (const g of grpMap.values()) {
    g.list.sort((a, b) => String(a.address || '').localeCompare(String(b.address || '')));
  }
  const sorted = [...grpMap.values()].sort((a, b) => {
    if (a.code === null && b.code === null) return a.label.localeCompare(b.label);
    if (a.code === null) return 1;   // 순번 없는 새 손님은 맨 뒤
    if (b.code === null) return -1;
    return a.code - b.code;
  });
  const unmatched = orders.length - matched;

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
          {unmatched > 0 && <span className="text-red-600">구역 미지정 {unmatched}건</span>}
        </div>
        <PrintBar date={date} kind="labels" />
      </div>

      <table className="w-full border-collapse text-[12px] leading-tight">
        <tbody>
          {sorted.map(g => (
            <React.Fragment key={g.code !== null ? `c${g.code}` : `x${g.label}`}>
              <tr>
                <td colSpan={5} className="border-b border-black pt-1.5 pb-0.5 font-black text-[11px]">
                  {g.code !== null
                    ? <><span className="text-[13px]">{g.code}</span>
                        <span className="font-normal ml-1">
                          {[...new Set(g.list.map(x => areaLabel(x)))].join(', ')}
                        </span></>
                    : <span className="text-red-600">구역 미지정 · {g.label}</span>}
                  <span className="font-normal text-stone-500 ml-1">{g.list.length}건</span>
                </td>
              </tr>
              {g.list.map(o => {
                no++;
                return (
                  <tr key={o.id} className="border-b border-stone-300">
                    <td className="py-[3px] pr-1 w-4 align-top text-stone-400 text-[10px]">{no}</td>
                    <td className="py-[3px] pr-1.5 w-[58px] align-top font-bold whitespace-nowrap">{o.baby_name}</td>
                    <td className="py-[3px] pr-1.5 align-top">
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
