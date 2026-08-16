import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, MENU_TYPES, type Order } from '@/lib/supabase';
import { kstToday, formatPhone } from '@/lib/dates';
import { orderDates, slicesOn, qtyOn, menuQtyOn, shiftDate } from '@/lib/orderItems';
import PrintAuto from '../PrintAuto';
import PrintBar from '../PrintBar';

export const dynamic = 'force-dynamic';

const DOW_KOR = ['일', '월', '화', '수', '목', '금', '토'];

// 배송 방식별로 나누는 이유: 직배송은 우리가 직접 돌고, 당일배송은 두발히어로에 넘기고,
// 택배는 포장해서 접수한다 — 동선이 완전히 달라서 섞여 있으면 현장에서 다시 분류해야 함.
const METHOD_ORDER = ['직배송', '당일배송', '택배익일배송'] as const;
const METHOD_LABEL: Record<string, string> = {
  '직배송': '🚗 직배송 — 우리가 직접 배달',
  '당일배송': '🛵 당일배송 — 두발히어로 접수',
  '택배익일배송': '📦 택배 익일배송 — 포장 후 접수',
  '미지정': '❓ 배송방식 미지정 — 확인 필요',
};

export default async function LabelsPage({ searchParams }: { searchParams: { date?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');
  const date = searchParams.date || kstToday();

  const sb = supabaseService();
  // 조리표와 동일 — 복합주문의 두 번째 날짜분도 그 날 주소록에 잡히도록 items 기준으로 거른다.
  const { data } = await sb.from('baby_food_orders').select('*')
    .gte('delivery_date', shiftDate(date, -21))
    .lte('delivery_date', shiftDate(date, 21))
    .neq('status', '취소').order('baby_name').limit(500);
  const orders: Order[] = (data || []).filter(o => orderDates(o as any).includes(date));

  const storeName = (process.env.NEXT_PUBLIC_STORE_NAME || '이유식').trim();
  const dow = DOW_KOR[new Date(date + 'T00:00:00Z').getUTCDay()];

  // delivery_method 컬럼이 생기기 전 주문은 값이 비어 있어서 전부 "미지정"으로 몰림 —
  // 주소·구역 정보로 최대한 추정해서 실제 동선대로 묶이게 한다(추정분은 화면에 표시).
  function methodOf(o: Order): { method: string; guessed: boolean } {
    if (METHOD_ORDER.includes(o.delivery_method as any)) return { method: o.delivery_method!, guessed: false };
    const addr = `${o.address || ''} ${o.address_detail || ''}`;
    if (/강서|양천/.test(addr)) return { method: '직배송', guessed: true };
    if (o.zone_group) return { method: '당일배송', guessed: true };
    return { method: '미지정', guessed: false };
  }

  // 배송방식 → (당일배송은 두발히어로 구역까지) 로 묶어서 나가는 순서대로 정렬
  const groups = new Map<string, Order[]>();
  for (const o of orders) {
    const { method } = methodOf(o);
    const key = method === '당일배송' && o.zone_group ? `당일배송|${o.zone_group}` : method;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(o);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const [ma] = a[0].split('|'), [mb] = b[0].split('|');
    const ia = METHOD_ORDER.indexOf(ma as any), ib = METHOD_ORDER.indexOf(mb as any);
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a[0].localeCompare(b[0]);
  });

  return (
    <div className="bg-white min-h-screen p-6 text-black print:p-4 max-w-3xl mx-auto">
      <PrintAuto />
      <div className="flex items-start justify-between mb-4 border-b-[3px] border-black pb-3 gap-4">
        <div>
          <div className="text-[10px] tracking-[0.2em] text-stone-500 mb-0.5">DELIVERY SHEET</div>
          <h1 className="text-2xl font-black">배송 주소록</h1>
          <div className="text-base font-bold mt-1">{date} ({dow})</div>
          <div className="text-sm text-stone-600">총 {orders.length}건 · {orders.reduce((s, o) => s + qtyOn(o as any, date), 0)}팩</div>
        </div>
        <PrintBar date={date} kind="labels" />
      </div>

      {/* 배송방식별 건수 요약 — 나가기 전에 몇 건씩인지 한눈에 */}
      {orders.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {sortedGroups.map(([key, list]) => {
            const [method, zone] = key.split('|');
            return (
              <div key={key} className="border-2 border-black rounded px-3 py-1.5 text-sm font-bold">
                {method}{zone ? ` (${zone})` : ''} <span className="ml-1 text-lg">{list.length}</span>건
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-5">
        {sortedGroups.map(([key, list]) => {
          const [method, zone] = key.split('|');
          return (
            <section key={key}>
              <div className="font-black text-sm bg-black text-white px-3 py-1.5 rounded-t flex justify-between">
                <span>{METHOD_LABEL[method] || method}{zone ? ` · ${zone} 구역` : ''}</span>
                <span>{list.length}건</span>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {list.map(o => (
                  <div key={o.id} className="border-2 border-black rounded-lg p-3 break-inside-avoid" style={{ minHeight: '170px' }}>
                    <div className="flex justify-between items-center border-b border-black pb-1 mb-1.5">
                      <div className="text-[10px] tracking-widest font-bold">{storeName}</div>
                      <div className="text-[10px]">{date} ({dow})</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-lg leading-none mt-0.5">☐</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-base font-black">{o.baby_name} <span className="text-xs font-normal">({o.months}개월)</span></div>
                        <div className="text-xs mb-1.5 font-bold">
                          {formatPhone(o.customer_phone)}
                          {methodOf(o).guessed && <span className="ml-1 font-normal text-[10px] text-stone-500">(배송방식 추정)</span>}
                        </div>
                        <div className="text-[13px] leading-snug mb-1.5">
                          {o.address}
                          {o.address_detail && <><br /><span className="font-bold">{o.address_detail}</span></>}
                          {o.door_password && <><br /><span className="text-xs font-bold">🔑 현관 {o.door_password}</span></>}
                        </div>
                      </div>
                    </div>
                    <div className="border-t border-stone-300 pt-1.5 flex justify-between items-end gap-2">
                      <div className="text-xs leading-snug min-w-0">
                        <strong>
                          {slicesOn(o as any, date).map(s =>
                            s.stage === '반찬세트' ? '반찬세트' : `${s.stage ?? '-'}${s.volume ? ` ${s.volume}g` : ''}`
                          ).join(' / ') || `${o.stage} ${o.volume}g`}
                        </strong>
                        <br />
                        {MENU_TYPES.filter(m => menuQtyOn(o as any, date, m) > 0)
                          .map(m => `${m.replace('기타단백질', '기타')} ${menuQtyOn(o as any, date, m)}`).join(' / ')}
                        {(o.allergies || []).length > 0 && (
                          <div className="text-[11px] font-black mt-0.5">⚠ {(o.allergies || []).join(', ')} 제외</div>
                        )}
                        {o.memo && <div className="text-[11px] text-stone-600 mt-0.5">메모: {o.memo}</div>}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-black text-xl leading-none">{qtyOn(o as any, date)}</div>
                        <div className="text-[10px] text-stone-500">팩</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}

        {orders.length === 0 && (
          <div className="py-16 text-center text-stone-400 border-2 border-dashed border-stone-300 rounded">
            이 날짜에 배송할 주문이 없습니다
          </div>
        )}
      </div>

      <div className="mt-6 pt-2 border-t border-stone-300 text-[10px] text-stone-400 flex justify-between">
        <span>{date} 배송 주소록 · 총 {orders.length}건</span>
        <span>출력 시각 {new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')} KST</span>
      </div>
    </div>
  );
}
