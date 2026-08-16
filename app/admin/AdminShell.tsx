'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Order, Customer, WeeklyMenu, OrderStatus, MenuType } from '@/lib/supabase';
import { MENU_TYPES, STAGES, STAGE_OPTIONS, PREPAID_UNITS } from '@/lib/supabase';
import { formatPhone, fmtDateTime } from '@/lib/dates';
import { slicesOn, qtyOn } from '@/lib/orderItems';

type Tab = '주문' | '통계' | '배송' | '조리표' | '주소록' | '메뉴관리' | '고객관리' | '후기' | '엑셀';

const STATUS_CLS: Record<OrderStatus, string> = {
  접수:    'bg-amber-100 text-amber-800 border-amber-200',
  준비중:  'bg-sky-100 text-sky-800 border-sky-200',
  배송완료:'bg-emerald-100 text-emerald-800 border-emerald-200',
  취소:    'bg-stone-100 text-stone-500 border-stone-200'
};

const NEXT_STATUS: Record<OrderStatus, OrderStatus> = {
  접수: '준비중', 준비중: '배송완료', 배송완료: '접수', 취소: '접수'
};

function shiftDay(date: string, days: number): string {
  const t = new Date(date + 'T00:00:00Z').getTime() + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export default function AdminShell({
  initialOrders, customers: initCustomers, weeklyMenus: initMenus,
  today, selectedDate, weekStart
}: {
  initialOrders: Order[];
  customers: Customer[];
  weeklyMenus: WeeklyMenu[];
  today: string;
  selectedDate: string;
  weekStart: string;
}) {
  const [tab, setTab] = useState<Tab>('주문');
  const [orders, setOrders] = useState<Order[]>(initialOrders);
  const [customers, setCustomers] = useState<Customer[]>(initCustomers);
  const [menus, setMenus] = useState<WeeklyMenu[]>(initMenus);
  const router = useRouter();

  // ── 공통 유틸 ─────────────────────────────────────────────────
  async function changeStatus(id: string, status: OrderStatus) {
    setOrders(prev => prev.map(o => o.id === id ? { ...o, status } : o));
    await fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
  }

  async function logout() {
    await fetch('/api/auth', { method: 'DELETE' });
    router.push('/admin/login');
  }

  // 복합 주문(delivery_sets 구조) 또는 구형(단순 배열) 모두 지원
  function isMultiOrder(order: Order) {
    const items = order.items as any[];
    return items.length > 0 && items[0].delivery_date !== undefined;
  }

  function getQty(order: Order, menu: MenuType) {
    const items = order.items as any[];
    if (isMultiOrder(order)) {
      return items.reduce((sum: number, d: any) =>
        sum + (d.sets || []).reduce((s2: number, s: any) =>
          s2 + ((s.menus || []).find((m: any) => m.menu === menu)?.qty || 0), 0), 0);
    }
    return items.find(i => i.menu === menu)?.qty || 0;
  }

  function renderOrderDetail(order: Order) {
    const items = order.items as any[];
    if (isMultiOrder(order)) {
      return items.map((d: any, di: number) => (
        <div key={di} className="text-xs text-stone-600 mt-1">
          <span className="font-bold text-amber-700">{d.delivery_date}</span>{' '}
          {(d.sets || []).map((s: any, si: number) => (
            <span key={si}>
              {s.stage} {s.volume}g:[{(s.menus||[]).filter((m:any)=>m.qty>0).map((m:any)=>`${m.menu} ${m.qty}`).join('·')}]{' '}
            </span>
          ))}
          <span className="text-amber-700 font-bold">{d.date_qty}팩</span>
        </div>
      ));
    }
    return (
      <div className="text-sm text-stone-700">
        {order.stage} · {order.volume}g ·{' '}
        {MENU_TYPES.filter(m => getQty(order, m) > 0).map(m => `${m} ${getQty(order, m)}팩`).join(' · ')}
      </div>
    );
  }

  const tabs: Tab[] = ['주문', '통계', '배송', '조리표', '주소록', '메뉴관리', '고객관리', '후기', '엑셀'];

  return (
    <div className="min-h-screen bg-stone-50">
      {/* 헤더 */}
      <header className="bg-white border-b border-stone-200 sticky top-0 z-20 no-print">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="font-bold text-stone-900">이유식 관리 <span className="text-sm text-stone-400 font-normal">{today}</span></h1>
          <button onClick={logout} className="text-xs text-stone-500 px-3 py-1.5 border border-stone-200 rounded-lg">
            로그아웃
          </button>
        </div>

        {/* 조리일 선택 — 기본은 오늘, 다른 날은 직접 골라서 본다.
            (주문은 항상 "내일 이후" 조리분이라 오늘만 볼 수 있으면 확인이 안 됐음) */}
        <div className="max-w-5xl mx-auto px-4 pb-2 flex items-center gap-2">
          <span className="text-xs text-stone-500 font-bold">조리일</span>
          <a href={`/admin?date=${shiftDay(selectedDate, -1)}`} aria-label="하루 전"
            className="px-2.5 py-1 rounded-lg border border-stone-200 bg-white text-sm">←</a>
          <input type="date" value={selectedDate}
            onChange={e => { if (e.target.value) router.push(`/admin?date=${e.target.value}`); }}
            className="px-2 py-1 border border-stone-200 rounded-lg text-sm font-bold bg-white" />
          <a href={`/admin?date=${shiftDay(selectedDate, 1)}`} aria-label="하루 후"
            className="px-2.5 py-1 rounded-lg border border-stone-200 bg-white text-sm">→</a>
          {selectedDate !== today && (
            <a href="/admin" className="text-xs text-amber-700 font-bold underline underline-offset-2">오늘</a>
          )}
        </div>
        <div className="max-w-5xl mx-auto px-4 flex gap-1 pb-0 overflow-x-auto no-scrollbar">
          {tabs.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${tab === t ? 'border-amber-500 text-amber-700' : 'border-transparent text-stone-500 hover:text-stone-700'}`}>
              {t}
              {t === '주문' && <span className="ml-1 text-xs bg-amber-100 text-amber-700 px-1.5 rounded-full">{orders.filter(o=>o.status!=='취소').length}</span>}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-5">
        {/* ── 탭 1: 오늘 주문 ─────────────────────────────── */}
        {tab === '주문' && (
          <div className="space-y-3">
            <div className="text-sm font-bold text-stone-700">
              {selectedDate} 조리분 <span className="text-amber-700">{orders.length}건</span>
            </div>
            {orders.length === 0 && (
              <Empty text={`${selectedDate}에 조리할 주문이 없어요`} />
            )}
            {orders.map(o => (
              <div key={o.id} className="bg-white rounded-xl border border-stone-200 p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <span className="font-bold text-stone-900 mr-2">{o.baby_name}</span>
                    <span className="text-xs text-stone-500">{o.months}개월</span>
                    {o.order_type !== '일반' && (
                      <span className="ml-2 text-[10px] bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">{o.order_type}</span>
                    )}
                  </div>
                  <button
                    onClick={() => changeStatus(o.id, NEXT_STATUS[o.status])}
                    className={`text-[11px] px-2.5 py-1 rounded-full border font-bold ${STATUS_CLS[o.status]}`}>
                    {o.status} →
                  </button>
                </div>
                <div className="mb-1.5 flex items-center gap-1.5 flex-wrap">
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${
                    o.delivery_method === '택배익일배송' ? 'bg-blue-100 text-blue-700'
                    : o.delivery_method === '직배송' ? 'bg-amber-100 text-amber-700'
                    : 'bg-emerald-100 text-emerald-700'}`}>
                    {o.delivery_method === '택배익일배송' ? '📦 택배익일' : o.delivery_method === '직배송' ? '🚗 직배송' : '🚚 당일배송'}
                  </span>
                  {o.zone_group && <span className="text-[11px] font-bold text-stone-600 bg-stone-100 px-2 py-0.5 rounded">{o.zone_group}</span>}
                </div>
                {o.allergies && o.allergies.length > 0 && (
                  <div className="mb-1.5 flex items-center gap-1 flex-wrap bg-rose-50 border border-rose-200 rounded-lg px-2 py-1">
                    <span className="text-[11px] font-bold text-rose-700">🚫 알레르기</span>
                    {o.allergies.map((a, i) => (
                      <span key={i} className="text-[11px] font-bold text-white bg-rose-500 px-1.5 py-0.5 rounded">{a}</span>
                    ))}
                  </div>
                )}
                <div className="mb-1">
                  {renderOrderDetail(o)}
                  <span className="text-xs font-bold text-amber-700">총 {o.total_qty}팩 / {o.total_price.toLocaleString()}원</span>
                </div>
                <div className="text-xs text-stone-500">
                  📍 {o.address}{o.address_detail ? ' ' + o.address_detail : ''}
                  {o.door_password && <span className="ml-2">🔑 {o.door_password}</span>}
                  <span className="ml-3">📞 {formatPhone(o.customer_phone)}</span>
                </div>
                {o.memo && <div className="mt-1 text-xs text-stone-500 italic">💬 {o.memo}</div>}
              </div>
            ))}
          </div>
        )}

        {/* ── 탭: 통계 ────────────────────────────────────── */}
        {tab === '통계' && <StatsTab />}

        {/* ── 탭 2: 조리표 ────────────────────────────────── */}
        {tab === '배송' && <DeliveryGroups orders={orders} today={selectedDate} />}

        {tab === '조리표' && <CookingSheet orders={orders} today={selectedDate} />}

        {/* ── 탭 3: 주소록 ────────────────────────────────── */}
        {tab === '주소록' && <AddressBook orders={orders} today={selectedDate} />}

        {/* ── 탭 4: 메뉴 관리 ─────────────────────────────── */}
        {tab === '메뉴관리' && (
          <MenuManager menus={menus} weekStart={weekStart} onSave={(m: WeeklyMenu[]) => setMenus(m)} />
        )}

        {/* ── 탭 5: 고객 관리 ─────────────────────────────── */}
        {tab === '고객관리' && (
          <CustomerManager customers={customers} onUpdate={(c: Customer[]) => setCustomers(c)} />
        )}

        {/* ── 후기 관리 ───────────────────────────────────── */}
        {tab === '후기' && <ReviewManager />}

        {/* ── 탭 6: 엑셀 ──────────────────────────────────── */}
        {tab === '엑셀' && <ExcelDownload today={today} />}
      </main>
    </div>
  );
}

// ── 조리표 ────────────────────────────────────────────────────────
function CookingSheet({ orders, today }: { orders: Order[]; today: string }) {
  // ⚠️ 예전엔 주문의 stage/volume으로 묶어서, 복합주문(stage='mixed', volume=null)이
  // 어느 그룹에도 안 잡혀 화면 조리표에서 통째로 빠졌음 — 인쇄용 조리표와 동일하게
  // "그날 몫 세트" 단위로 묶는다.
  type Row = { order: Order; menus: Record<string, number>; qty: number };
  const totals: Record<MenuType, number> = { 한우: 0, 닭: 0, 기타단백질: 0 };
  const groupMap = new Map<string, { stage: string; volume: number; rows: Row[] }>();
  for (const o of orders) {
    for (const s of slicesOn(o as any, today)) {
      for (const m of MENU_TYPES) totals[m] += s.menus[m] || 0;
      const key = `${s.stage ?? '-'}|${s.volume ?? 0}`;
      if (!groupMap.has(key)) groupMap.set(key, { stage: String(s.stage ?? '-'), volume: Number(s.volume ?? 0), rows: [] });
      groupMap.get(key)!.rows.push({ order: o, menus: s.menus, qty: s.qty });
    }
  }
  const STAGE_ORDER: string[] = [...STAGES];
  const groups = [...groupMap.values()].sort((a, b) => {
    const ai = STAGE_ORDER.indexOf(a.stage), bi = STAGE_ORDER.indexOf(b.stage);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a.volume - b.volume;
  });

  return (
    <div>
      <div className="flex gap-2 mb-4 no-print">
        <button onClick={() => window.open(`/admin/print/cooking?date=${today}`, '_blank')}
          className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-bold">
          🖨 조리표 프린트
        </button>
      </div>

      <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-5">
        {groups.length === 0 && <div className="text-center text-stone-400 text-sm py-6">오늘 조리할 주문이 없어요</div>}
        {groups.map(g => (
          <div key={`${g.stage}-${g.volume}`}>
            <div className="font-bold text-sm border-b-2 border-stone-900 pb-1 mb-2">
              ■ {g.stage}{g.volume ? ` (${g.volume}g)` : ''} — {g.rows.length}명 / {g.rows.reduce((s, r) => s + r.qty, 0)}팩
            </div>
            <table className="w-full text-sm">
              <tbody>
                {g.rows.map((row, ri) => (
                  <tr key={`${row.order.id}-${ri}`} className="border-b border-stone-100">
                    <td className="py-1.5 font-bold w-24">{row.order.baby_name}</td>
                    <td className="py-1.5">
                      {MENU_TYPES.filter(m => (row.menus[m] || 0) > 0).map(m => `${m.replace('기타단백질','기타')} ${row.menus[m]}팩`).join(' · ')}
                    </td>
                    <td className="py-1.5 text-right text-stone-500 text-xs w-12">{row.qty}팩</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        <div className="border-t-2 border-stone-900 pt-3">
          <div className="font-bold text-sm mb-2">■ 합계</div>
          <div className="flex gap-6 text-sm">
            {MENU_TYPES.map(m => (
              <div key={m}><span className="text-stone-500">{m}</span> <strong>{totals[m]}팩</strong></div>
            ))}
            <div><span className="text-stone-500">전체</span> <strong>{Object.values(totals).reduce((a,b)=>a+b,0)}팩</strong></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 주소록 ─────────────────────────────────────────────────────────
// ── 배송 구역별 묶음 (두발히어로 기사 전달용) ──────────────────────
function DeliveryGroups({ orders, today }: { orders: Order[]; today: string }) {
  const active = orders.filter(o => o.status !== '취소');
  const kindOf = (o: Order) => o.delivery_method || '당일배송';
  const direct = active.filter(o => kindOf(o) === '직배송');
  const parcel = active.filter(o => kindOf(o) === '택배익일배송');
  const dubal = active.filter(o => kindOf(o) === '당일배송');

  // 당일배송(두발) → 구역별
  const byZone: Record<string, Order[]> = {};
  dubal.forEach(o => { const z = o.zone_group || '구역미확인'; (byZone[z] = byZone[z] || []).push(o); });
  const zones = Object.keys(byZone).sort();

  const Row = (o: Order) => (
    <div key={o.id} className="px-3 py-2 flex items-start gap-2 text-sm">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-bold text-stone-900">{o.baby_name}</span>
          <span className="text-xs text-stone-500">{formatPhone(o.customer_phone)}</span>
          {/* 복합주문은 total_qty가 전체 날짜 합계라 그날 배송량과 다름 — 그날 몫만 표시 */}
          <span className="text-xs font-bold text-amber-700">{qtyOn(o as any, today)}팩</span>
        </div>
        <div className="text-xs text-stone-600 truncate">
          {o.address}{o.address_detail ? ' ' + o.address_detail : ''}
          {o.door_password && <span className="ml-1 text-stone-400">🔑{o.door_password}</span>}
        </div>
      </div>
    </div>
  );

  const Section = ({ title, color, items, count }: { title: string; color: string; items: React.ReactNode; count: number }) => (
    <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
      <div className={`px-4 py-2.5 font-bold text-sm flex items-center justify-between ${color}`}>
        <span>{title}</span><span className="text-xs">{count}건</span>
      </div>
      {count === 0 ? <div className="p-4 text-center text-stone-400 text-xs">없음</div> : <div className="divide-y divide-stone-100">{items}</div>}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* 요약 */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-amber-50 rounded-lg py-2"><div className="text-lg font-black text-amber-700">{direct.length}</div><div className="text-[11px] text-amber-600">🚗 직배송</div></div>
        <div className="bg-emerald-50 rounded-lg py-2"><div className="text-lg font-black text-emerald-700">{dubal.length}</div><div className="text-[11px] text-emerald-600">🚚 당일(두발)</div></div>
        <div className="bg-blue-50 rounded-lg py-2"><div className="text-lg font-black text-blue-700">{parcel.length}</div><div className="text-[11px] text-blue-600">📦 택배익일</div></div>
      </div>

      <Section title="🚗 직배송 (우리가 직접)" color="bg-amber-100 text-amber-800" count={direct.length} items={direct.map(Row)} />

      {/* 당일배송 — 구역별 */}
      <div>
        <div className="text-sm font-bold text-emerald-800 mb-2">🚚 당일배송 · 두발히어로 (구역별 {zones.length}구역)</div>
        <div className="space-y-2">
          {dubal.length === 0 && <div className="bg-white rounded-xl border border-stone-200 p-4 text-center text-stone-400 text-xs">없음</div>}
          {zones.map(z => (
            <div key={z} className="bg-white rounded-xl border border-emerald-200 overflow-hidden">
              <div className="px-4 py-2 bg-emerald-50 font-bold text-sm text-emerald-800 flex items-center justify-between">
                <span>{z}</span><span className="text-xs">{byZone[z].length}건</span>
              </div>
              <div className="divide-y divide-stone-100">{byZone[z].map(Row)}</div>
            </div>
          ))}
        </div>
      </div>

      <Section title="📦 택배 익일배송" color="bg-blue-100 text-blue-800" count={parcel.length} items={parcel.map(Row)} />
    </div>
  );
}

function AddressBook({ orders, today }: { orders: Order[]; today: string }) {
  return (
    <div>
      <div className="flex gap-2 mb-4 no-print">
        <button onClick={() => window.open(`/admin/print/labels?date=${today}`, '_blank')}
          className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-bold">
          🖨 배송 주소록 프린트
        </button>
      </div>
      <div className="bg-white rounded-xl border border-stone-200 divide-y divide-stone-100">
        {orders.length === 0 && <div className="p-8 text-center text-stone-500 text-sm">주문 없음</div>}
        {orders.map((o, i) => (
          <div key={o.id} className="px-4 py-3 flex items-start gap-3">
            <span className="text-stone-400 text-sm w-5 pt-0.5">{i+1}</span>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="font-bold text-stone-900">{o.baby_name}</span>
                <span className="text-xs text-stone-500">{formatPhone(o.customer_phone)}</span>
              </div>
              <div className="text-sm text-stone-700">
                {o.address}{o.address_detail ? ' ' + o.address_detail : ''}
                {o.door_password && <span className="ml-2 text-xs text-stone-500">🔑 {o.door_password}</span>}
              </div>
              {/* 복합주문은 stage='mixed'라 그날 실제 단계·용량이 안 보였고 팩수도 전체합계였음 */}
              <div className="text-xs text-stone-500 mt-0.5">
                {slicesOn(o as any, today).map(s => `${s.stage ?? '-'}${s.volume ? ` ${s.volume}g` : ''}`).join(' / ') || `${o.stage} · ${o.volume}g`}
                {' · '}
                {MENU_TYPES.map(m => ({ m, q: slicesOn(o as any, today).reduce((s, x) => s + (x.menus[m] || 0), 0) }))
                  .filter(x => x.q > 0).map(x => `${x.m} ${x.q}`).join(' / ')}
                {' · 총 '}{qtyOn(o as any, today)}팩
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 메뉴 관리 ──────────────────────────────────────────────────────
function MenuManager({ menus, weekStart, onSave }: { menus: WeeklyMenu[]; weekStart: string; onSave: (m: WeeklyMenu[]) => void }) {
  const [veg, setVeg] = useState<Record<MenuType, string>>({
    한우: menus.find(m => m.menu_type === '한우')?.vegetables || '',
    닭: menus.find(m => m.menu_type === '닭')?.vegetables || '',
    기타단백질: menus.find(m => m.menu_type === '기타단백질')?.vegetables || ''
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function saveMenu(menuType: MenuType) {
    setSaving(true);
    setMsg(null);
    const r = await fetch('/api/menus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week_start: weekStart, menu_type: menuType, vegetables: veg[menuType] })
    });
    const d = await r.json();
    setSaving(false);
    setMsg(d.ok ? '저장됐어요!' : `오류: ${d.error}`);
    setTimeout(() => setMsg(null), 2000);
  }

  return (
    <div>
      <div className="text-sm text-stone-500 mb-4">이번 주 ({weekStart}~) 메뉴 등록</div>
      <div className="space-y-4">
        {MENU_TYPES.map(m => (
          <div key={m} className="bg-white rounded-xl border border-stone-200 p-4">
            <label className="block text-sm font-bold text-stone-900 mb-2">{m}</label>
            <div className="flex gap-2">
              <input
                value={veg[m]}
                onChange={e => setVeg(p => ({ ...p, [m]: e.target.value }))}
                placeholder="당근, 시금치, 브로콜리"
                className="flex-1 px-3 py-2.5 border border-stone-200 rounded-lg text-sm outline-none focus:border-amber-400"
              />
              <button onClick={() => saveMenu(m)} disabled={saving}
                className="px-4 py-2.5 bg-amber-500 text-white rounded-lg text-sm font-bold disabled:opacity-50">
                저장
              </button>
            </div>
          </div>
        ))}
      </div>
      {msg && <div className="mt-3 text-sm text-center text-emerald-700">{msg}</div>}
    </div>
  );
}

// ── 고객 관리 ──────────────────────────────────────────────────────
function CustomerManager({ customers, onUpdate }: { customers: Customer[]; onUpdate: (c: Customer[]) => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const prepaid = customers.filter(c => c.prepaid_balance > 0 || c.is_regular);

  async function charge(id: string, units: typeof PREPAID_UNITS[number]) {
    const r = await fetch(`/api/customers/${id}/prepaid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ units })
    });
    const d = await r.json();
    if (d.ok) {
      onUpdate(customers.map(c => c.id === id ? { ...c, prepaid_balance: d.new_balance } : c));
      setMsg(`${units}팩 충전됐어요 (잔여 ${d.new_balance}팩)`);
    } else {
      setMsg(`오류: ${d.error}`);
    }
    setTimeout(() => setMsg(null), 3000);
  }

  return (
    <div>
      {msg && <div className="mb-3 text-sm text-center text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg py-2">{msg}</div>}
      {prepaid.length === 0 && <Empty text="등록된 고객이 없어요" />}
      <div className="space-y-3">
        {prepaid.map(c => (
          <div key={c.id} className="bg-white rounded-xl border border-stone-200 p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="font-bold text-stone-900 mr-2">{c.baby_name}</span>
                <span className="text-xs text-stone-500">{formatPhone(c.phone)}</span>
                {c.is_regular && <span className="ml-2 text-[10px] bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">정기</span>}
              </div>
              <div className={`font-bold ${c.prepaid_balance <= 5 ? 'text-red-600' : 'text-amber-700'}`}>
                잔여 {c.prepaid_balance}팩
              </div>
            </div>
            {/* regular_schedule은 배열이 아니라 { stage, volume, slots:[{day,qty}] } 객체 —
                예전엔 배열로 다뤄서(.length/.map) 정기배송 스케줄이 화면에 전혀 안 나왔음 */}
            {c.is_regular && (c.regular_schedule?.slots?.length ?? 0) > 0 && (
              <div className="text-xs text-stone-500 mb-2">
                정기: {c.regular_schedule?.stage}
                {c.regular_schedule?.volume ? ` ${c.regular_schedule.volume}g` : ''}
                {' · '}
                {(c.regular_schedule?.slots || []).map(s => `${s.day} ${s.qty}팩`).join(' · ')}
              </div>
            )}
            <div className="flex gap-2">
              {PREPAID_UNITS.map(u => (
                <button key={u} onClick={() => charge(c.id, u)}
                  className="px-3 py-1.5 border border-amber-200 text-amber-700 rounded-lg text-xs font-bold hover:bg-amber-50">
                  +{u}팩
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 후기 관리 ─────────────────────────────────────────────────────
// 후기는 승인 절차 없이 바로 손님 화면에 공개되는데(is_approved 기본 true) 정작 내릴 방법이
// 없어서, 부적절한 후기가 올라와도 손쓸 수가 없었음 — 여기서 공개/숨김을 전환한다.
type AdminReview = { id: string; baby_name: string; rating: number; content: string; created_at: string; is_approved: boolean };

function ReviewManager() {
  const [reviews, setReviews] = useState<AdminReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const d = await fetch('/api/reviews?all=1').then(r => r.json());
      if (d.ok) setReviews(d.reviews);
    } catch {}
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggle(r: AdminReview) {
    setBusy(r.id);
    const next = !r.is_approved;
    const d = await fetch('/api/reviews', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: r.id, is_approved: next }),
    }).then(x => x.json()).catch(() => ({ ok: false }));
    if (d.ok) setReviews(prev => prev.map(x => x.id === r.id ? { ...x, is_approved: next } : x));
    setBusy(null);
  }

  if (loading) return <div className="text-center py-10 text-stone-400 text-sm">불러오는 중…</div>;
  if (reviews.length === 0) return <Empty text="아직 등록된 후기가 없어요" />;

  const shown = reviews.filter(r => r.is_approved).length;
  return (
    <div className="space-y-3">
      <div className="text-xs text-stone-500">
        전체 {reviews.length}개 · 공개 중 {shown}개 · 숨김 {reviews.length - shown}개
        <span className="block mt-0.5 text-stone-400">숨김으로 바꾸면 손님 화면과 평균 별점에서 즉시 빠집니다.</span>
      </div>
      {reviews.map(r => (
        <div key={r.id} className={`bg-white rounded-xl border p-4 ${r.is_approved ? 'border-stone-200' : 'border-stone-200 bg-stone-50 opacity-70'}`}>
          <div className="flex items-start justify-between gap-3 mb-1.5">
            <div className="min-w-0">
              <span className="font-bold text-stone-900 mr-2">{r.baby_name} 부모님</span>
              <span className="text-amber-500 text-sm">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span>
              <div className="text-[11px] text-stone-400 mt-0.5">{fmtDateTime(r.created_at)}</div>
            </div>
            <button onClick={() => toggle(r)} disabled={busy === r.id}
              className={`text-[11px] px-2.5 py-1 rounded-full border font-bold whitespace-nowrap disabled:opacity-50 ${
                r.is_approved ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : 'bg-stone-200 text-stone-600 border-stone-300'}`}>
              {busy === r.id ? '처리 중…' : r.is_approved ? '공개 중 → 숨기기' : '숨김 → 공개하기'}
            </button>
          </div>
          <p className="text-sm text-stone-700 leading-relaxed whitespace-pre-wrap">{r.content}</p>
        </div>
      ))}
    </div>
  );
}

// ── 엑셀 다운로드 ─────────────────────────────────────────────────
function ExcelDownload({ today }: { today: string }) {
  const [from, setFrom] = useState(today.slice(0, 8) + '01'); // 이달 1일
  const [to, setTo] = useState(today);

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-6 max-w-md">
      <h2 className="font-bold text-stone-900 mb-4">주문내역 엑셀 다운로드</h2>
      <div className="space-y-3 mb-5">
        <div>
          <label className="text-xs text-stone-500 block mb-1">조리일 시작</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            className="w-full px-3 py-2.5 border border-stone-200 rounded-lg text-sm" />
        </div>
        <div>
          <label className="text-xs text-stone-500 block mb-1">조리일 종료</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            className="w-full px-3 py-2.5 border border-stone-200 rounded-lg text-sm" />
        </div>
      </div>
      <a href={`/api/export?from=${from}&to=${to}`}
        className="block w-full py-3 bg-amber-500 text-white text-center font-bold rounded-xl text-sm">
        📊 엑셀 다운로드
      </a>
      <p className="text-xs text-stone-400 mt-3 text-center">컬럼: 조리일·아기이름·개월수·단계·용량·한우·닭·기타단백질·총팩수·총금액·주소·연락처·상태</p>
    </div>
  );
}

type Stats = {
  today: { revenue: number; orders: number };
  thisMonth: { revenue: number; orders: number; newCustomers: number };
  totalCustomers: number; repeatRate: number;
  monthly: { month: string; revenue: number; orders: number }[];
  bySource: { source: string; revenue: number; orders: number }[];
};

function StatsTab() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/stats').then(r => r.json()).then(d => { if (d.ok) setStats(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-center py-16 text-stone-400 text-sm">불러오는 중…</div>;
  if (!stats) return <Empty text="통계를 불러오지 못했어요" />;

  const maxRevenue = Math.max(1, ...stats.monthly.map(m => m.revenue));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <div className="text-xs text-stone-400 mb-1">오늘 매출</div>
          <div className="text-xl font-black text-stone-900">{stats.today.revenue.toLocaleString()}원</div>
          <div className="text-[11px] text-stone-400 mt-0.5">주문 {stats.today.orders}건</div>
        </div>
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <div className="text-xs text-stone-400 mb-1">이번 달 매출</div>
          <div className="text-xl font-black text-amber-700">{stats.thisMonth.revenue.toLocaleString()}원</div>
          <div className="text-[11px] text-stone-400 mt-0.5">주문 {stats.thisMonth.orders}건</div>
        </div>
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <div className="text-xs text-stone-400 mb-1">이번 달 신규고객</div>
          <div className="text-xl font-black text-emerald-700">{stats.thisMonth.newCustomers}명</div>
          <div className="text-[11px] text-stone-400 mt-0.5">첫 주문 기준</div>
        </div>
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <div className="text-xs text-stone-400 mb-1">재구매율</div>
          <div className="text-xl font-black text-violet-700">{stats.repeatRate}%</div>
          <div className="text-[11px] text-stone-400 mt-0.5">전체 고객 {stats.totalCustomers}명 중 2회 이상</div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <div className="text-sm font-bold text-stone-800 mb-3">월별 매출 (최근 12개월)</div>
        <div className="flex items-end gap-1.5 overflow-x-auto" style={{ height: 160 }}>
          {stats.monthly.map(m => {
            const h = m.revenue === 0 ? 2 : Math.max(4, Math.round((m.revenue / maxRevenue) * 120));
            return (
              <div key={m.month} className="flex flex-col items-center justify-end h-full" style={{ minWidth: 44 }}>
                <div className="flex-1 flex flex-col justify-end items-center w-full">
                  <span className="text-[9px] font-bold text-stone-500 mb-0.5 whitespace-nowrap">
                    {m.revenue > 0 ? Math.round(m.revenue / 10000) + '만' : '0'}
                  </span>
                  <div className={`w-full rounded-t ${m.revenue === 0 ? 'bg-stone-200' : 'bg-amber-400'}`} style={{ height: h }} />
                </div>
                <span className="text-[10px] text-stone-400 mt-1 border-t border-stone-100 w-full text-center pt-1">{+m.month.slice(5, 7)}월</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <div className="text-sm font-bold text-stone-800 mb-1">유입경로별 성과</div>
        <div className="text-[11px] text-stone-400 mb-3">주문 링크에 ?src=채널명을 붙여 공유하면 여기 집계돼요 (예: ?src=insta)</div>
        {stats.bySource.length === 0 ? (
          <div className="text-center py-8 text-stone-400 text-xs">아직 유입경로가 기록된 주문이 없어요</div>
        ) : (
          <div className="space-y-2">
            {stats.bySource.map(s => (
              <div key={s.source} className="flex items-center justify-between bg-stone-50 rounded-lg px-3 py-2">
                <span className="text-sm font-bold text-stone-800">{s.source}</span>
                <span className="text-xs text-stone-500">{s.orders}건 · {s.revenue.toLocaleString()}원</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="bg-white rounded-xl border border-stone-200 py-16 text-center text-stone-400 text-sm">{text}</div>;
}
