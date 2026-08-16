import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, type Order } from '@/lib/supabase';
import { kstToday, formatPhone } from '@/lib/dates';
import { orderDates, qtyOn, shiftDate } from '@/lib/orderItems';
import PrintAuto from '../PrintAuto';
import PrintBar from '../PrintBar';

export const dynamic = 'force-dynamic';

const DOW_KOR = ['일', '월', '화', '수', '목', '금', '토'];

// 사장님이 직접 도는 배송만 인쇄한다 — 택배(익일)는 포장해서 접수하는 거라
// 들고 나가는 주소록에 있을 필요가 없음.
function isDrivenByUs(o: Order): boolean {
  const m = o.delivery_method;
  if (m === '택배익일배송') return false;
  if (m === '직배송' || m === '당일배송') return true;
  // delivery_method가 없던 예전 주문은 주소로 추정 (강서·양천이면 직배송)
  return /강서|양천/.test(`${o.address || ''} ${o.address_detail || ''}`);
}

// 동네 묶음은 "구" 단위로 — 손님이 주소를 "강서구화곡동 851-95"처럼 붙여 쓰기도 해서
// 동까지 키로 잡으면 같은 동네가 "강서구"와 "강서구 화곡동"으로 갈라졌음.
// 구로 묶고, 그 안에서는 주소순으로 정렬해 같은 동끼리 자연스럽게 붙게 한다.
function areaOf(o: Order): string {
  const addr = String(o.address || '').replace(/^(서울특별시|서울시|서울)\s*/, '').trim();
  const gu = addr.match(/([가-힣]+구)/)?.[1];
  if (gu) return gu;
  return o.zone_group ? String(o.zone_group) : '기타';
}

// 동 표시(있으면) — 배송 순서를 잡을 때 눈으로 훑기 좋게 한 칸에 보여줌
function dongOf(o: Order): string {
  const addr = String(o.address || '').replace(/^(서울특별시|서울시|서울)\s*/, '').trim();
  const gu = addr.match(/([가-힣]+구)/)?.[1] || '';
  const rest = gu ? addr.slice(addr.indexOf(gu) + gu.length) : addr;
  return rest.match(/([가-힣]+[동읍면])/)?.[1] || '';
}

// "없음", "-" 같이 의미 없는 현관비번은 지면만 차지하므로 표시하지 않음
function doorPw(o: Order): string {
  const v = String(o.door_password || '').trim();
  if (!v || /^(없음|없어요|없습니다|-|없)$/.test(v)) return '';
  return v;
}

export default async function LabelsPage({ searchParams }: { searchParams: { date?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');
  const date = searchParams.date || kstToday();

  const sb = supabaseService();
  // 복합주문의 두 번째 날짜분도 그 날 주소록에 잡히도록 items 기준으로 거른다.
  const { data } = await sb.from('baby_food_orders').select('*')
    .gte('delivery_date', shiftDate(date, -21))
    .lte('delivery_date', shiftDate(date, 21))
    .neq('status', '취소').order('baby_name').limit(500);
  const all: Order[] = (data || []).filter(o => orderDates(o as any).includes(date));
  const orders = all.filter(isDrivenByUs);
  const parcelCount = all.length - orders.length;

  // 동네별로 묶어서, 건수 많은 동네부터. 그룹 안에서는 주소순(=같은 동끼리 붙음)
  const groups = new Map<string, Order[]>();
  for (const o of orders) {
    const k = areaOf(o);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(o);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.address || '').localeCompare(String(b.address || '')));
  }
  const sorted = [...groups.entries()].sort((a, b) =>
    b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const dow = DOW_KOR[new Date(date + 'T00:00:00Z').getUTCDay()];
  let no = 0;

  return (
    <div className="bg-white min-h-screen p-6 text-black print:p-4 max-w-3xl mx-auto">
      <PrintAuto />
      <div className="flex items-start justify-between mb-4 border-b-[3px] border-black pb-3 gap-4">
        <div>
          <div className="text-[10px] tracking-[0.2em] text-stone-500 mb-0.5">DELIVERY SHEET</div>
          <h1 className="text-2xl font-black">배송 주소록</h1>
          <div className="text-base font-bold mt-1">{date} ({dow})</div>
          <div className="text-sm text-stone-600">
            직접 배송 {orders.length}건
            {parcelCount > 0 && <span className="text-stone-400"> · 택배 {parcelCount}건은 제외</span>}
          </div>
        </div>
        <PrintBar date={date} kind="labels" />
      </div>

      {sorted.map(([area, list]) => (
        <section key={area} className="mb-4 break-inside-avoid">
          <div className="font-black text-sm bg-black text-white px-3 py-1.5 flex justify-between">
            <span>{area}</span><span>{list.length}건</span>
          </div>
          <table className="w-full text-sm border-x-2 border-b-2 border-black">
            <tbody>
              {list.map(o => {
                no++;
                return (
                  <tr key={o.id} className="border-b border-stone-300 last:border-0">
                    <td className="py-2 px-2 w-7 align-top text-lg leading-none">☐</td>
                    <td className="py-2 px-1 w-7 align-top text-stone-500 text-xs">{no}</td>
                    <td className="py-2 px-1 w-24 align-top font-black whitespace-nowrap">{o.baby_name}</td>
                    <td className="py-2 px-1 align-top">
                      {dongOf(o) && <span className="font-bold mr-1">[{dongOf(o)}]</span>}
                      {o.address}
                      {o.address_detail && <span className="font-bold"> {o.address_detail}</span>}
                      {doorPw(o) && <span className="text-xs"> (현관 {doorPw(o)})</span>}
                    </td>
                    <td className="py-2 px-2 align-top text-right whitespace-nowrap font-bold">
                      {formatPhone(o.customer_phone)}
                    </td>
                    <td className="py-2 px-2 align-top text-right whitespace-nowrap font-black w-12">
                      {qtyOn(o as any, date)}팩
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}

      {orders.length === 0 && (
        <div className="py-16 text-center text-stone-400 border-2 border-dashed border-stone-300 rounded">
          {parcelCount > 0
            ? `이 날짜는 택배 ${parcelCount}건만 있어요 (직접 배송할 주문 없음)`
            : '이 날짜에 배송할 주문이 없습니다'}
        </div>
      )}

      <div className="mt-6 pt-2 border-t border-stone-300 text-[10px] text-stone-400 flex justify-between">
        <span>{date} 배송 주소록 · 직접 배송 {orders.length}건</span>
        <span>출력 시각 {new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')} KST</span>
      </div>
    </div>
  );
}
