import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, MENU_TYPES, type Order, type MenuType } from '@/lib/supabase';
import { kstToday } from '@/lib/dates';
import { orderDates, slicesOn, qtyOn, shiftDate } from '@/lib/orderItems';
import PrintAuto from '../PrintAuto';

export const dynamic = 'force-dynamic';

export default async function CookingPrint({ searchParams }: { searchParams: { date?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');
  const date = searchParams.date || kstToday();

  const sb = supabaseService();
  // ⚠️ 복합주문은 여러 날짜분이 한 행에 들어있고 delivery_date 칸엔 그중 첫 날짜만 저장됨 —
  // delivery_date로만 조회하면 "월+목" 주문의 목요일분이 목요일 조리표에서 통째로 사라졌음.
  // 앞뒤 3주를 넉넉히 가져와서 items 안의 실제 조리일로 다시 걸러낸다.
  const { data } = await sb.from('baby_food_orders').select('*')
    .gte('delivery_date', shiftDate(date, -21))
    .lte('delivery_date', shiftDate(date, 21))
    .neq('status', '취소').order('created_at').limit(500);
  const orders: Order[] = (data || []).filter(o => orderDates(o as any).includes(date));

  // 그 날짜분 세트만 뽑아서 단계·용량별로 묶음 — 복합주문(stage='mixed')도 세트 단위로는
  // 실제 단계/용량을 갖고 있어서 이렇게 하면 정상적으로 조리표에 잡힌다.
  const totals: Record<MenuType, number> = { 한우: 0, 닭: 0, 기타단백질: 0 };
  const groupMap = new Map<string, { stage: string; volume: number; rows: { order: Order; menus: Record<string, number>; qty: number }[] }>();
  for (const o of orders) {
    for (const s of slicesOn(o as any, date)) {
      for (const m of MENU_TYPES) totals[m] += s.menus[m] || 0;
      const key = `${s.stage ?? '-'}|${s.volume ?? 0}`;
      if (!groupMap.has(key)) groupMap.set(key, { stage: String(s.stage ?? '-'), volume: Number(s.volume ?? 0), rows: [] });
      groupMap.get(key)!.rows.push({ order: o, menus: s.menus, qty: s.qty });
    }
  }
  const groups = [...groupMap.values()].sort((a, b) =>
    a.stage === b.stage ? a.volume - b.volume : a.stage.localeCompare(b.stage));
  const totalPacks = orders.reduce((sum, o) => sum + qtyOn(o as any, date), 0);

  return (
    <div className="bg-white min-h-screen p-8 max-w-2xl mx-auto text-black print:text-black">
      <PrintAuto />
      <div className="flex justify-between items-start mb-6 border-b-2 border-black pb-4">
        <div>
          <div className="text-xs tracking-widest text-stone-500 mb-1">COOKING SHEET</div>
          <h1 className="text-2xl font-bold">이유식 조리표</h1>
          <div className="text-sm mt-1">{date} · 총 {orders.length}명 / {totalPacks}팩</div>
        </div>
        <div className="no-print flex gap-2">
          <button onClick={() => window.print()} className="px-5 py-2 bg-black text-white rounded-lg font-bold text-sm">🖨 인쇄</button>
          <button onClick={() => window.close()} className="px-5 py-2 bg-stone-200 rounded-lg text-sm">닫기</button>
        </div>
      </div>

      <div className="space-y-5">
        {groups.map(g => (
          <section key={`${g.stage}-${g.volume}`}>
            <div className="font-bold border-b-2 border-black pb-1 mb-2">
              ■ {g.stage}{g.volume ? ` (${g.volume}g)` : ''} — {g.rows.length}명
            </div>
            <table className="w-full text-sm">
              <tbody>
                {g.rows.map((row, ri) => (
                  <tr key={`${row.order.id}-${ri}`} className="border-b border-stone-200">
                    <td className="py-1.5 font-bold w-24 pr-3">{row.order.baby_name}</td>
                    <td className="py-1.5">
                      {MENU_TYPES.filter(m => (row.menus[m] || 0) > 0)
                        .map(m => `${m.replace('기타단백질','기타')} ${row.menus[m]}팩`)
                        .join(' · ')}
                    </td>
                    <td className="py-1.5 text-right text-stone-500 text-xs">{row.qty}팩</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}

        {orders.length === 0 && <div className="py-12 text-center text-stone-400">주문이 없습니다</div>}
      </div>

      <div className="mt-6 pt-4 border-t-2 border-black">
        <div className="font-bold mb-2">■ 메뉴별 합계</div>
        <div className="grid grid-cols-4 gap-4 text-center">
          {MENU_TYPES.map(m => (
            <div key={m} className="border border-black rounded p-3">
              <div className="text-xs text-stone-500 mb-1">{m}</div>
              <div className="text-2xl font-bold">{totals[m]}<span className="text-sm font-normal">팩</span></div>
            </div>
          ))}
          <div className="border-2 border-black rounded p-3">
            <div className="text-xs text-stone-500 mb-1">전체</div>
            <div className="text-2xl font-bold">{Object.values(totals).reduce((a,b)=>a+b,0)}<span className="text-sm font-normal">팩</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
