import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, MENU_TYPES, type Order, type MenuType } from '@/lib/supabase';
import { kstToday, formatPhone } from '@/lib/dates';
import PrintAuto from '../PrintAuto';

export const dynamic = 'force-dynamic';

export default async function LabelsPage({ searchParams }: { searchParams: { date?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');
  const date = searchParams.date || kstToday();

  const sb = supabaseService();
  const { data } = await sb.from('baby_food_orders').select('*')
    .eq('delivery_date', date).neq('status', '취소').order('baby_name');
  const orders: Order[] = data || [];

  function getQty(o: Order, m: MenuType) {
    return (o.items as any[]).find(i => i.menu === m)?.qty || 0;
  }

  const storeName = (process.env.NEXT_PUBLIC_STORE_NAME || '이유식').trim();

  return (
    <div className="bg-white min-h-screen p-4 text-black">
      <PrintAuto />
      <div className="no-print flex items-center justify-between mb-4 max-w-3xl mx-auto">
        <h1 className="font-bold">{date} 배송 주소록 ({orders.length}건)</h1>
        <div className="flex gap-2">
          <button onClick={() => window.print()} className="px-5 py-2 bg-black text-white rounded-lg font-bold text-sm">🖨 인쇄</button>
          <button onClick={() => window.close()} className="px-5 py-2 bg-stone-200 rounded-lg text-sm">닫기</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 max-w-3xl mx-auto">
        {orders.map(o => (
          <div key={o.id} className="border-2 border-black rounded-lg p-3 break-inside-avoid" style={{ minHeight: '180px' }}>
            <div className="flex justify-between items-center border-b border-black pb-1.5 mb-2">
              <div className="text-[10px] tracking-widest font-bold">{storeName}</div>
              <div className="text-[10px]">{date}</div>
            </div>
            <div className="text-base font-bold mb-0.5">{o.baby_name} ({o.months}개월)</div>
            <div className="text-xs mb-2 text-stone-600">{formatPhone(o.customer_phone)}</div>
            <div className="text-[13px] leading-snug mb-2">
              {o.address}
              {o.address_detail && <><br />{o.address_detail}</>}
              {o.door_password && <><br /><span className="text-xs text-stone-600">🔑 {o.door_password}</span></>}
            </div>
            <div className="border-t border-stone-300 pt-1.5 flex justify-between items-end">
              <div className="text-xs leading-snug">
                <strong>{o.stage} · {o.volume}g</strong><br />
                {MENU_TYPES.filter(m => getQty(o, m) > 0).map(m => `${m.replace('기타단백질','기타')} ${getQty(o,m)}`).join(' / ')}
                {o.memo && <div className="text-[11px] text-stone-600 mt-0.5">⚠ {o.memo}</div>}
              </div>
              <div className="text-right">
                <div className="font-bold text-lg">{o.total_qty}팩</div>
                <div className="text-[9px] text-stone-400">{o.id.slice(0,8)}</div>
              </div>
            </div>
          </div>
        ))}
        {orders.length === 0 && (
          <div className="col-span-2 py-20 text-center text-stone-400">주문이 없습니다</div>
        )}
      </div>
    </div>
  );
}
