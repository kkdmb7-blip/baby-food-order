import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, STAGES, STAGE_OPTIONS, MENU_TYPES, type Order, type MenuType } from '@/lib/supabase';
import { kstToday } from '@/lib/dates';
import PrintAuto from '../PrintAuto';

export const dynamic = 'force-dynamic';

export default async function CookingPrint({ searchParams }: { searchParams: { date?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');
  const date = searchParams.date || kstToday();

  const sb = supabaseService();
  const { data } = await sb.from('baby_food_orders').select('*')
    .eq('delivery_date', date).neq('status', '취소').order('created_at');
  const orders: Order[] = data || [];

  function getQty(o: Order, m: MenuType) {
    return (o.items as any[]).find(i => i.menu === m)?.qty || 0;
  }

  const totals: Record<MenuType, number> = { 한우: 0, 닭: 0, 기타단백질: 0 };
  for (const o of orders) for (const m of MENU_TYPES) totals[m] += getQty(o, m);

  const groups: { stage: string; volume: number; orders: Order[] }[] = [];
  for (const stage of STAGES) {
    for (const opt of STAGE_OPTIONS[stage]) {
      const list = orders.filter(o => o.stage === stage && o.volume === opt.volume);
      if (list.length > 0) groups.push({ stage, volume: opt.volume, orders: list });
    }
  }

  return (
    <div className="bg-white min-h-screen p-8 max-w-2xl mx-auto text-black print:text-black">
      <PrintAuto />
      <div className="flex justify-between items-start mb-6 border-b-2 border-black pb-4">
        <div>
          <div className="text-xs tracking-widest text-stone-500 mb-1">COOKING SHEET</div>
          <h1 className="text-2xl font-bold">이유식 조리표</h1>
          <div className="text-sm mt-1">{date} · 총 {orders.length}명 / {Object.values(totals).reduce((a,b)=>a+b,0)}팩</div>
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
              ■ {g.stage} ({g.volume}g) — {g.orders.length}명
            </div>
            <table className="w-full text-sm">
              <tbody>
                {g.orders.map(o => (
                  <tr key={o.id} className="border-b border-stone-200">
                    <td className="py-1.5 font-bold w-24 pr-3">{o.baby_name}</td>
                    <td className="py-1.5">
                      {MENU_TYPES.filter(m => getQty(o, m) > 0)
                        .map(m => `${m.replace('기타단백질','기타')} ${getQty(o,m)}팩`)
                        .join(' · ')}
                    </td>
                    <td className="py-1.5 text-right text-stone-500 text-xs">{o.total_qty}팩</td>
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
