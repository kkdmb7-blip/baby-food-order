'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Order, Customer, WeeklyMenu, OrderStatus, MenuType } from '@/lib/supabase';
import { MENU_TYPES, STAGES, STAGE_OPTIONS, PREPAID_UNITS, menuLabel } from '@/lib/supabase';
import { formatPhone, fmtDateTime } from '@/lib/dates';
import { withSubject } from '@/lib/korean';
import { slicesOn, qtyOn, orderDates } from '@/lib/orderItems';
import { routeCodeOf, addrKey } from '@/lib/routeCode';
import GridEntry from './GridEntry';
import SheetEditor from './SheetEditor';

// '카톡주문' 탭은 뺐다 — 주문접수(조리표 탭) 맨 위에서 붙여넣으면 바로 읽어 채우므로
// 같은 일을 두 군데서 하게 된다. 컴포넌트(KakaoOrderEntry.tsx)는 남겨 뒀다.
type Tab = '주문' | '통계' | '배송' | '조리표' | '주소록' | '메뉴관리' | '고객관리' | '후기' | '엑셀';
const TABS: Tab[] = ['주문', '통계', '배송', '조리표', '주소록', '메뉴관리', '고객관리', '후기', '엑셀'];
const TAB_KEY = 'kkdmb-admin-tab';

const STATUS_CLS: Record<OrderStatus, string> = {
  접수:    'bg-amber-100 text-amber-800 border-amber-200',
  준비중:  'bg-sky-100 text-sky-800 border-sky-200',
  배송중:  'bg-violet-100 text-violet-800 border-violet-200',
  배송완료:'bg-emerald-100 text-emerald-800 border-emerald-200',
  취소:    'bg-stone-100 text-stone-500 border-stone-200'
};

const NEXT_STATUS: Record<OrderStatus, OrderStatus> = {
  접수: '준비중', 준비중: '배송중', 배송중: '배송완료', 배송완료: '접수', 취소: '접수'
};

const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];

function shiftDay(date: string, days: number): string {
  const t = new Date(date + 'T00:00:00Z').getTime() + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export default function AdminShell({
  initialOrders, cancelledOrders, customers: initCustomers, weeklyMenus: initMenus,
  today, selectedDate, weekStart
}: {
  initialOrders: Order[];
  cancelledOrders: Order[];
  customers: Customer[];
  weeklyMenus: WeeklyMenu[];
  today: string;
  selectedDate: string;
  weekStart: string;
}) {
  // 탭은 기억해 둔다. 날짜를 옮기거나 저장 뒤 화면이 새로 그려질 때 '주문' 탭으로 튕겨
  // 다시 조리표 탭을 누르게 되는 일이 있었다. 조리표에서 치고 있으면 거기 머물러야 한다.
  const [tab, setTabState] = useState<Tab>('주문');
  useEffect(() => {
    try {
      const t = sessionStorage.getItem(TAB_KEY) as Tab | null;
      if (t && TABS.includes(t)) setTabState(t);
    } catch { /* 못 읽어도 '주문' 탭으로 시작하면 된다 */ }
  }, []);
  function setTab(t: Tab) {
    setTabState(t);
    try { sessionStorage.setItem(TAB_KEY, t); } catch { /* 기억만 못 하는 것 */ }
  }

  const [orders, setOrders] = useState<Order[]>(initialOrders);
  // 서버에서 새로 받은 주문으로 맞춘다. 전에는 처음 받은 것만 들고 있어서
  // 날짜를 바꿔도(?date=) 화면의 조리표는 전 날짜 것이 남아 있었다.
  useEffect(() => { setOrders(initialOrders); }, [initialOrders]);
  // 주문 찾기 — 문의 전화가 오면 날짜를 옮겨가며 눈으로 찾아야 했음
  const [search, setSearch] = useState('');
  const [searchResult, setSearchResult] = useState<Order[] | null>(null);
  const [searching, setSearching] = useState(false);
  // 상태 필터 + 일괄 선택
  const [filter, setFilter] = useState<'전체' | '미입금' | '접수' | '준비중' | '배송중' | '배송완료'>('전체');
  const [picked, setPicked] = useState<Set<string>>(new Set());
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

  async function runSearch() {
    const q = search.trim();
    if (!q) { setSearchResult(null); return; }
    setSearching(true);
    const d = await fetch(`/api/orders?q=${encodeURIComponent(q)}`).then(r => r.json()).catch(() => null);
    setSearching(false);
    setSearchResult(d?.orders || []);
  }

  // 배송 나갈 때 10건을 하나씩 누르지 않아도 되게
  async function bulkStatus(next: OrderStatus) {
    const ids = [...picked];
    if (ids.length === 0) return;
    if (!confirm(`${ids.length}건을 '${next}'(으)로 바꿀까요?`)) return;
    setOrders(prev => prev.map(o => picked.has(o.id) ? { ...o, status: next } : o));
    setPicked(new Set());
    await Promise.all(ids.map(id => fetch(`/api/orders/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    }).catch(() => {})));
    router.refresh();
  }

  async function saveMemo(o: Order, memo: string) {
    if ((o.memo || '') === memo.trim()) return;
    setOrders(prev => prev.map(x => x.id === o.id ? { ...x, memo: memo.trim() || null } : x));
    await fetch(`/api/orders/${o.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memo }),
    }).catch(() => {});
  }

  // 아기 이름 고치기 — 조리표에 찍히는 이름이 카카오 채널에 저장해 둔 이름과 같아야
  // 주문이 누구 것인지 맞춰볼 수 있다. 동명이인은 카톡에 '찬희2'로 저장해 두시므로
  // 앱 이름도 그렇게 고칠 수 있어야 한다. 앱이 꼬리표를 붙여 맞추면 오히려 어긋난다.
  async function saveName(o: Order, name: string) {
    const next = name.trim().slice(0, 20);
    if (!next || next === o.baby_name) return;
    setOrders(prev => prev.map(x => x.id === o.id ? { ...x, baby_name: next } : x));
    const r = await fetch(`/api/orders/${o.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baby_name: next }),
    }).catch(() => null);
    // 실패하면 되돌린다 — 고쳐진 줄 알고 넘어가면 조리표에 옛 이름이 찍힌다
    if (!r || !r.ok) {
      setOrders(prev => prev.map(x => x.id === o.id ? { ...x, baby_name: o.baby_name } : x));
      alert('이름을 못 고쳤어요. 다시 해주세요.');
    }
  }

  // 조리일 고치기 — 손님이 날짜를 잘못 적거나 아예 안 적는 일이 많다.
  // 고치면 이 날짜 화면에서는 빠지므로(다른 날로 갔으니) 목록을 다시 받는다.
  async function saveDate(o: Order, next: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || next === o.delivery_date) return;
    const was = o.delivery_date;
    setOrders(prev => prev.map(x => x.id === o.id ? { ...x, delivery_date: next } : x));
    const r = await fetch(`/api/orders/${o.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivery_date: next }),
    }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok || j.ok === false) {
      // 못 바꿨으면 되돌린다 — 바뀐 줄 알고 넘어가면 그날 조리표에서 빠진다
      setOrders(prev => prev.map(x => x.id === o.id ? { ...x, delivery_date: was } : x));
      alert(j.error || '조리일을 못 바꿨어요');
      return;
    }
    router.refresh();
  }

  async function togglePaid(o: Order) {
    const next = !o.paid;
    setOrders(prev => prev.map(x => x.id === o.id ? { ...x, paid: next } : x));
    const d = await fetch(`/api/orders/${o.id}/paid`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: next }),
    }).then(r => r.json()).catch(() => ({ ok: false }));
    // 실패하면 되돌림 — 입금 상태가 화면과 DB에서 달라지면 대조가 무의미해짐
    if (!d.ok) setOrders(prev => prev.map(x => x.id === o.id ? { ...x, paid: !next } : x));
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
        {MENU_TYPES.filter(m => getQty(order, m) > 0).map(m => `${menuLabel(m)} ${getQty(order, m)}팩`).join(' · ')}
      </div>
    );
  }

  const tabs = TABS;

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
          {/* 전에는 <a href> 라 날짜를 옮길 때마다 페이지를 처음부터 다시 받았다(느리고 탭도 풀렸다).
              이제 화면만 다시 그린다 — 주문 목록은 위 useEffect 가 새 값으로 맞춘다. */}
          <button onClick={() => router.push(`/admin?date=${shiftDay(selectedDate, -1)}`)} aria-label="하루 전"
            className="px-2.5 py-1 rounded-lg border border-stone-200 bg-white text-sm">←</button>
          <input type="date" value={selectedDate}
            onChange={e => { if (e.target.value) router.push(`/admin?date=${e.target.value}`); }}
            className="px-2 py-1 border border-stone-200 rounded-lg text-sm font-bold bg-white" />
          <button onClick={() => router.push(`/admin?date=${shiftDay(selectedDate, 1)}`)} aria-label="하루 후"
            className="px-2.5 py-1 rounded-lg border border-stone-200 bg-white text-sm">→</button>
          <span className="text-sm font-bold text-stone-600">({DOW_KO[new Date(selectedDate + 'T00:00:00Z').getUTCDay()]})</span>
          {selectedDate !== today && (
            <button onClick={() => router.push('/admin')}
              className="text-xs text-amber-700 font-bold underline underline-offset-2">오늘</button>
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
            {/* 주문 찾기 — 이름 또는 연락처. 날짜와 무관하게 전체에서 찾는다 */}
            <div className="flex gap-2">
              <input value={search} onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
                placeholder="이름 또는 연락처로 주문 찾기"
                className="flex-1 px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-amber-400" />
              <button onClick={runSearch} disabled={searching}
                className="px-4 py-2 bg-stone-800 text-white rounded-lg text-sm font-bold disabled:opacity-50">
                {searching ? '찾는 중' : '찾기'}
              </button>
              {searchResult && (
                <button onClick={() => { setSearch(''); setSearchResult(null); }}
                  className="px-3 py-2 border border-stone-200 rounded-lg text-sm">닫기</button>
              )}
            </div>

            {searchResult && (
              <div className="bg-white rounded-xl border border-stone-300 p-3">
                <div className="text-sm font-bold text-stone-700 mb-2">검색 결과 {searchResult.length}건</div>
                {searchResult.length === 0 && <div className="text-sm text-stone-400 py-3 text-center">일치하는 주문이 없어요</div>}
                <div className="divide-y divide-stone-100">
                  {searchResult.map(o => (
                    <a key={o.id} href={`/admin?date=${o.delivery_date}`} className="block py-2 hover:bg-stone-50">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-stone-900">{o.baby_name}
                          <span className="ml-2 text-xs font-normal text-stone-500">{formatPhone(o.customer_phone)}</span>
                        </span>
                        <span className={`text-[11px] px-2 py-0.5 rounded-full border font-bold ${STATUS_CLS[o.status]}`}>{o.status}</span>
                      </div>
                      <div className="text-xs text-stone-600 mt-0.5">
                        조리일 <span className="font-bold text-amber-700">{o.delivery_date}</span>
                        {' · '}{o.total_qty}팩 · {o.total_price.toLocaleString()}원
                        {!o.paid && o.order_type !== '선결제' && <span className="ml-1 text-rose-600 font-bold">미입금</span>}
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div className="text-sm font-bold text-stone-700 flex items-center gap-2 flex-wrap">
              <span>{selectedDate} 조리분 <span className="text-amber-700">{orders.length}건</span></span>
              {(() => {
                const unpaid = orders.filter(o => !o.paid && o.order_type !== '선결제');
                const amount = unpaid.reduce((s, o) => s + (o.total_price || 0), 0);
                if (unpaid.length === 0) return orders.length > 0
                  ? <span className="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">입금 전부 확인됨</span>
                  : null;
                return (
                  <span className="text-xs font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-2 py-0.5">
                    미입금 {unpaid.length}건 · {amount.toLocaleString()}원
                  </span>
                );
              })()}
            </div>
            {/* 상태 필터 — "미입금만", "준비중만" 같은 걸 걸 수 있게 */}
            <div className="flex gap-1.5 flex-wrap">
              {(['전체', '미입금', '접수', '준비중', '배송중', '배송완료'] as const).map(f => {
                const n = f === '전체' ? orders.length
                  : f === '미입금' ? orders.filter(o => !o.paid && o.order_type !== '선결제').length
                  : orders.filter(o => o.status === f).length;
                return (
                  <button key={f} onClick={() => { setFilter(f); setPicked(new Set()); }}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold border ${
                      filter === f ? 'bg-stone-800 border-stone-800 text-white' : 'bg-white border-stone-200 text-stone-600'}`}>
                    {f} {n}
                  </button>
                );
              })}
            </div>

            {/* 일괄 처리 — 배송 나갈 때 하나씩 누르지 않아도 되게 */}
            {picked.size > 0 && (
              <div className="sticky top-[132px] z-10 bg-stone-800 text-white rounded-xl px-3 py-2 flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold">{picked.size}건 선택</span>
                <button onClick={() => bulkStatus('준비중')} className="text-xs px-2.5 py-1 bg-white/15 rounded-lg font-bold">준비중</button>
                <button onClick={() => bulkStatus('배송중')} className="text-xs px-2.5 py-1 bg-white/15 rounded-lg font-bold">배송중</button>
                <button onClick={() => bulkStatus('배송완료')} className="text-xs px-2.5 py-1 bg-white/15 rounded-lg font-bold">배송완료</button>
                <button onClick={() => setPicked(new Set())} className="text-xs px-2 py-1 ml-auto opacity-70">선택 해제</button>
              </div>
            )}

            {orders.length === 0 && (
              <Empty text={`${selectedDate}에 조리할 주문이 없어요`} />
            )}
            {orders.filter(o =>
              filter === '전체' ? true
              : filter === '미입금' ? (!o.paid && o.order_type !== '선결제')
              : o.status === filter
            ).map(o => (
              <div key={o.id} className="bg-white rounded-xl border border-stone-200 p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-start gap-2">
                    <input type="checkbox" checked={picked.has(o.id)}
                      onChange={e => setPicked(prev => {
                        const n = new Set(prev);
                        if (e.target.checked) n.add(o.id); else n.delete(o.id);
                        return n;
                      })}
                      className="mt-1 w-4 h-4 accent-stone-800" />
                    <div>
                      {/* 눌러서 바로 고친다 — 카톡 이름과 맞추려면 '찬희2' 처럼 직접 적으셔야 한다 */}
                      <input
                        key={o.id + o.baby_name}
                        defaultValue={o.baby_name}
                        onBlur={e => saveName(o, e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        maxLength={20}
                        title="눌러서 고칠 수 있어요 (카톡 이름과 같게)"
                        className="font-bold text-stone-900 mr-1 bg-transparent border border-transparent rounded px-1 -ml-1
                                   hover:border-stone-200 focus:border-amber-400 focus:bg-white outline-none"
                        style={{ width: `${Math.max(3, o.baby_name.length + 1)}ch` }}
                      />
                      <span className="text-xs text-stone-500">{o.months}개월</span>
                      {o.order_type !== '일반' && (
                        <span className="ml-2 text-[10px] bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">{o.order_type}</span>
                      )}
                      {/* 조리일 — 손님이 날짜를 잘못 적거나 안 적는 일이 많다. 여기서 바로 고친다.
                          여러 날짜가 묶인 주문은 어느 쪽을 옮길지 알 수 없어 글자로만 보여준다. */}
                      <div className="mt-1 flex items-center gap-1">
                        <span className="text-[10px] text-stone-400">조리일</span>
                        {orderDates(o as any).length > 1 ? (
                          <span className="text-[11px] font-bold text-stone-600">
                            {orderDates(o as any).join(', ')}
                            <span className="ml-1 font-normal text-stone-400">(여러 날 묶음 — 취소하고 다시 넣어야 바뀝니다)</span>
                          </span>
                        ) : (
                          <>
                            <input type="date" defaultValue={o.delivery_date}
                              key={o.id + o.delivery_date}
                              onChange={e => saveDate(o, e.target.value)}
                              title="손님이 날짜를 잘못 적었으면 여기서 고칩니다"
                              className="px-1 py-0.5 border border-stone-200 rounded text-[11px] font-bold bg-white
                                         hover:border-stone-300 focus:border-amber-400 outline-none" />
                            <span className="text-[11px] font-bold text-stone-500">
                              ({DOW_KO[new Date(o.delivery_date + 'T00:00:00Z').getUTCDay()]})
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => changeStatus(o.id, NEXT_STATUS[o.status])}
                    className={`text-[11px] px-2.5 py-1 rounded-full border font-bold ${STATUS_CLS[o.status]}`}>
                    {o.status} →
                  </button>
                </div>
                <div className="mb-1.5 flex items-center gap-1.5 flex-wrap">
                  {/* 픽업은 배송을 안 나가므로 배송 방법보다 먼저, 눈에 띄게 */}
                  {(o as any).receive_method === '픽업' ? (
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-emerald-600 text-white">
                      🏠 픽업 (배송 안 나감)
                    </span>
                  ) : (
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${
                    o.delivery_method === '택배익일배송' ? 'bg-blue-100 text-blue-700'
                    : o.delivery_method === '직배송' ? 'bg-amber-100 text-amber-700'
                    : 'bg-emerald-100 text-emerald-700'}`}>
                    {o.delivery_method === '택배익일배송' ? '📦 택배익일' : o.delivery_method === '직배송' ? '🚗 직배송' : '🚚 당일배송'}
                  </span>
                  )}
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
                  {/* 입금 확인 — 엑셀·파이썬으로 대조하던 걸 여기서 바로 체크 */}
                  <button onClick={() => togglePaid(o)}
                    className={`ml-2 text-[11px] px-2 py-0.5 rounded-full border font-bold ${
                      o.paid ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
                             : 'bg-rose-100 text-rose-700 border-rose-200'}`}>
                    {o.paid ? '입금확인' : '미입금'}
                  </button>
                </div>
                {o.customer_request && (
                  <div className="mb-1 text-xs bg-sky-50 border border-sky-200 rounded-lg px-2 py-1 text-sky-800">
                    📌 손님 요청: {o.customer_request}
                  </div>
                )}
                <div className="text-xs text-stone-500">
                  📍 {o.address}{o.address_detail ? ' ' + o.address_detail : ''}
                  {o.door_password && <span className="ml-2">🔑 {o.door_password}</span>}
                  <span className="ml-3">📞 {formatPhone(o.customer_phone)}</span>
                </div>
                {/* 메모 — 표시만 되고 적을 곳이 없었음. 조리표에도 함께 나감 */}
                <input
                  defaultValue={o.memo || ''}
                  onBlur={e => saveMemo(o, e.target.value)}
                  maxLength={200}
                  placeholder="메모 남기기 (조리표에도 표시돼요)"
                  className="mt-2 w-full px-2.5 py-1.5 border border-stone-200 rounded-lg text-xs outline-none focus:border-amber-400 bg-stone-50"
                />
              </div>
            ))}

            {/* 취소된 주문 — 조리·배송에서는 빠지지만 "취소된 게 있었는지"는 확인돼야 함 */}
            {cancelledOrders.length > 0 && (
              <div className="pt-2">
                <div className="text-xs font-bold text-stone-500 mb-1.5">이 날짜의 취소된 주문 {cancelledOrders.length}건</div>
                <div className="bg-stone-100 rounded-xl divide-y divide-stone-200">
                  {cancelledOrders.map(o => (
                    <div key={o.id} className="px-3 py-2 flex items-center justify-between gap-2 text-sm">
                      <span className="text-stone-500 line-through">{o.baby_name}</span>
                      <span className="text-xs text-stone-400">
                        {o.total_qty}팩 · {o.total_price.toLocaleString()}원 · {formatPhone(o.customer_phone)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 카톡주문 탭은 뺐다 — 주문접수(조리표 탭) 맨 위에 붙여넣으면 바로 읽어 채운다 */}

        {tab === '통계' && <StatsTab />}

        {/* ── 탭 2: 조리표 ────────────────────────────────── */}
        {tab === '배송' && <DeliveryGroups orders={orders} today={selectedDate} />}

        {tab === '조리표' && (
          <>
            {/* 조리표를 보면서 바로 줄을 넣을 수 있게. 프린트할 땐 안 나온다(no-print).
                '조리표에 줄 넣기'(CookingEntry) 는 뺐다 — 거기만 할 수 있던 반찬 세트·픽업·
                권역 고르기·선결제·손님요청이 주문접수 안으로 들어왔다. 같은 일을 두 군데서
                하면 한쪽만 고치게 된다. 컴포넌트 파일은 남겨 뒀다.
                날짜는 이 화면의 selectedDate 하나뿐이다 — 주문접수에서 날짜를 바꾸면
                주소창(?date=)까지 같이 바뀌어서 넣은 주문이 바로 아래 조리표에 보인다. */}
            {/* 저장할 때마다 서버에서 주문 500건을 다시 받으면 한 건 넣을 때마다 화면이 멈춘다.
                만들어진 줄만 받아서 꽂는다 — 아래 조리표에 바로 보이고 기다릴 게 없다. */}
            <GridEntry date={selectedDate} orders={orders}
              onSaved={rows => {
                if (rows?.length) setOrders(prev => [...(rows as Order[]), ...prev]);
                else router.refresh();
              }}
              onDateChange={d => router.push(`/admin?date=${d}`)} />
            <CookingSheet orders={orders} today={selectedDate} customers={customers}
              onChanged={() => router.refresh()} />
          </>
        )}

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
type PrintInfo = {
  printed: boolean; printedAt?: string; printedOrders?: number; printedPacks?: number;
  newOrders?: number; newPacks?: number;
};

function CookingSheet({ orders, today, customers, onChanged }: {
  orders: Order[]; today: string; customers: Customer[]; onChanged: () => void;
}) {
  // 고치고 있는 사람(연락처). 한 사람이 중기·후기를 같이 시키기도 하니 줄이 아니라 사람 단위로 연다.
  const [editPhone, setEditPhone] = useState<string | null>(null);
  /*
    조리표를 언제 뽑았는지 기억해 둔다. 오전 7시에 뽑으신 뒤 들어오는 주문을
    지금까지는 종이에 손으로 적으셨다. 뽑은 시각을 알면 그 뒤에 들어온 줄만
    따로 뽑아드릴 수 있다.
  */
  const [printInfo, setPrintInfo] = useState<PrintInfo | null>(null);

  async function loadPrintInfo() {
    try {
      const d = await fetch(`/api/admin/cooking-print?date=${today}`).then(r => r.json());
      if (d.ok) setPrintInfo(d);
    } catch { /* 못 읽어도 조리표 자체는 보여야 한다 */ }
  }
  useEffect(() => { setPrintInfo(null); loadPrintInfo(); /* eslint-disable-next-line */ }, [today, orders.length]);

  async function printAll() {
    // 창을 먼저 연다 — fetch 를 기다렸다 열면 팝업 차단에 걸린다(사용자 클릭과 멀어져서)
    window.open(`/admin/print/cooking?date=${today}`, '_blank');
    try {
      await fetch('/api/admin/cooking-print', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: today }),
      });
    } catch { /* 기록 실패해도 프린트는 이미 떴다 */ }
    loadPrintInfo();
  }

  // ⚠️ 예전엔 주문의 stage/volume으로 묶어서, 복합주문(stage='mixed', volume=null)이
  // 어느 그룹에도 안 잡혀 화면 조리표에서 통째로 빠졌음 — 인쇄용 조리표와 동일하게
  // "그날 몫 세트" 단위로 묶는다.
  type Row = { order: Order; menus: Record<string, number>; qty: number };
  const totals: Record<MenuType, number> = { 한우: 0, 닭: 0, 기타단백질: 0 };
  // 팩수 합계는 메뉴 합과 따로 센다 — 메뉴를 안 적은 몫(카톡에 "300g 3팩" 만 온 경우)이
  // 있으면 둘이 다르다. 메뉴 합만 보여주면 그 팩은 어디에도 안 세어져 만드는 양이 모자란다.
  let packTotal = 0;
  const groupMap = new Map<string, { stage: string; volume: number; rows: Row[] }>();
  for (const o of orders) {
    for (const s of slicesOn(o as any, today)) {
      for (const m of MENU_TYPES) totals[m] += s.menus[m] || 0;
      packTotal += Number(s.qty) || 0;
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
      <div className="mb-4 no-print">
        <div className="flex gap-2 flex-wrap">
          <button onClick={printAll}
            className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-bold">
            🖨 조리표
          </button>
          {/* 담는 쪽은 "누가 뭘 먹는지"가 아니라 "단계·용량별 몇 개"만 보면 된다.
              엑셀에서도 '조리갯수' 시트를 따로 뽑아 담는 대에서 쓰고 계셨다. */}
          <button onClick={() => window.open(`/admin/print/tally?date=${today}`, '_blank')}
            className="px-4 py-2 bg-white border-2 border-stone-400 text-stone-700 rounded-lg text-sm font-bold">
            📋 담는 수량 프린트
          </button>
          {/* '추가분만 프린트' 는 뺐다 — 쓰지 않는 기능이다.
              프린트한 뒤 몇 건 들어왔는지는 아래 줄에 그대로 나오고,
              추가분이 있으면 조리표를 다시 뽑으신다. */}
        </div>

        {/* 언제 뽑았고 그 뒤로 몇 건이 들어왔는지. 지금까지 이 줄들을 종이에 손으로 적으셨다. */}
        {printInfo?.printed && (
          <p className="mt-2 text-xs text-stone-500 leading-relaxed">
            {fmtDateTime(printInfo.printedAt!)}에 뽑으셨어요 — 그때 {printInfo.printedOrders}명 {printInfo.printedPacks}팩.
            {(printInfo.newOrders ?? 0) > 0
              ? <span className="text-amber-700 font-bold"> 그 뒤로 {printInfo.newOrders}명 {printInfo.newPacks}팩이 더 들어왔습니다.</span>
              : <span> 그 뒤로 들어온 주문은 없습니다.</span>}
          </p>
        )}
        {printInfo && !printInfo.printed && (
          <p className="mt-2 text-xs text-stone-400">아직 이 날짜 조리표를 뽑지 않으셨어요.</p>
        )}
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
                    <td className="py-1.5 font-bold w-24">
                      {row.order.baby_name}
                      {/* 프린트한 뒤에 들어온 줄 — 손에 든 종이에는 없는 사람이다 */}
                      {printInfo?.printedAt && row.order.created_at > printInfo.printedAt && (
                        <span className="ml-1 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-px align-middle">추가</span>
                      )}
                    </td>
                    <td className="py-1.5">
                      {MENU_TYPES.filter(m => (row.menus[m] || 0) > 0).map(m => `${menuLabel(m)} ${row.menus[m]}팩`).join(' · ')}
                    </td>
                    <td className="py-1.5 text-right text-stone-500 text-xs w-12">{row.qty}팩</td>
                    {/* 손님이 바꿔 달라고 하실 때 — 여기서 바로 고친다(프린트에는 안 나온다) */}
                    <td className="py-1.5 pl-1 w-12 no-print">
                      <button onClick={() => setEditPhone(p => p === row.order.customer_phone ? null : row.order.customer_phone)}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-stone-300 text-stone-500 hover:bg-amber-50 hover:text-amber-800 hover:border-amber-300">
                        고치기
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* 이 묶음에 고치는 중인 사람이 있으면 바로 아래에 펼친다 */}
            {editPhone && g.rows.some(r => r.order.customer_phone === editPhone) && (
              <div className="no-print">
                <SheetEditor
                  date={today}
                  orders={orders.filter(o => o.customer_phone === editPhone)}
                  customers={customers}
                  onClose={() => setEditPhone(null)}
                  onChanged={onChanged}
                />
              </div>
            )}
          </div>
        ))}

        <div className="border-t-2 border-stone-900 pt-3">
          <div className="font-bold text-sm mb-2">■ 합계</div>
          <div className="flex gap-6 text-sm flex-wrap">
            {MENU_TYPES.map(m => (
              <div key={m}><span className="text-stone-500">{m}</span> <strong>{totals[m]}팩</strong></div>
            ))}
            {packTotal - Object.values(totals).reduce((a, b) => a + b, 0) > 0 && (
              <div className="text-rose-700">
                <span>메뉴 미정</span>{' '}
                <strong>{packTotal - Object.values(totals).reduce((a, b) => a + b, 0)}팩</strong>
              </div>
            )}
            <div><span className="text-stone-500">전체</span> <strong>{packTotal}팩</strong></div>
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

function AddressBook({ orders: allOrders, today }: { orders: Order[]; today: string }) {
  // 인쇄물과 동일한 기준 — 직접 도는 강서구·양천구만. 그 밖의 지역은 두발히어로·택배로
  // 나가므로 들고 나갈 주소록에 있으면 방해가 된다. (배송 탭에서는 전부 볼 수 있음)
  // ⚠️ 여기 조건이 인쇄물(app/admin/print/labels)과 어긋나면 화면과 종이가 달라지므로 같이 고칠 것.
  const orders = allOrders.filter(o =>
    (o as any).receive_method !== '픽업' && // 픽업은 손님이 찾아오므로 배송 주소록에서 제외
    (o.delivery_method === '직배송' || /강서구|양천구/.test(`${o.address || ''} ${o.address_detail || ''}`))
  );
  const excluded = allOrders.length - orders.length; // 두발·택배 등 직접 안 도는 건

  // 배송 순번 — 엑셀 기본 매핑 + 사장님이 저장한 값(우선)
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/route-code').then(r => r.json()).then(d => {
      if (!d.ok) return;
      const m: Record<string, number> = {};
      (d.rows || []).forEach((r: any) => { m[r.addr_key] = Number(r.code); });
      setOverrides(m);
    }).catch(() => {});
  }, []);

  const codeOf = (o: Order): number | null => {
    const k = addrKey(String(o.address || ''));
    if (k && overrides[k] !== undefined) return overrides[k];
    return routeCodeOf(String(o.address || ''));
  };

  async function saveCode(o: Order, raw: string) {
    const k = addrKey(String(o.address || ''));
    if (!k) { setMsg('이 주소는 순번을 붙일 수 없어요 (주소 형식 확인 필요)'); return; }
    setSaving(o.id); setMsg(null);
    const value = raw.trim() === '' ? null : Number(raw);
    const d = await fetch('/api/route-code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: o.address, code: value }),
    }).then(r => r.json()).catch(() => ({ ok: false, error: '저장 실패' }));
    setSaving(null);
    if (!d.ok) { setMsg(d.error || '저장 실패'); return; }
    setOverrides(prev => {
      const next = { ...prev };
      if (d.code === null) delete next[k]; else next[k] = d.code;
      return next;
    });
    setMsg(d.code === null ? '순번을 지웠어요 (기본값으로 되돌아감)' : `순번 ${d.code} 저장됨 — 같은 주소는 다음부터 자동 적용돼요`);
    setTimeout(() => setMsg(null), 3000);
  }

  // 순번대로 정렬 — 인쇄물과 같은 순서로 보이게
  const sorted = [...orders].sort((a, b) => {
    const ca = codeOf(a), cb = codeOf(b);
    if (ca === null && cb === null) return 0;
    if (ca === null) return 1;
    if (cb === null) return -1;
    return ca - cb;
  });

  return (
    <div>
      <div className="flex gap-2 mb-3 no-print items-center flex-wrap">
        <button onClick={() => window.open(`/admin/print/labels?date=${today}`, '_blank')}
          className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-bold">
          🖨 배송 주소록 프린트
        </button>
        {excluded > 0 && <span className="text-xs text-stone-500">강서·양천 외 {excluded}건 제외 (배송 탭에서 확인)</span>}
        <span className="text-xs text-stone-400">순번 칸에 숫자를 넣으면 저장돼요 (비우면 기본값)</span>
      </div>
      {msg && <div className="mb-3 text-sm text-center text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg py-2">{msg}</div>}
      <div className="bg-white rounded-xl border border-stone-200 divide-y divide-stone-100">
        {orders.length === 0 && <div className="p-8 text-center text-stone-500 text-sm">직접 배송할 주문 없음</div>}
        {sorted.map(o => (
          <div key={o.id} className="px-4 py-3 flex items-start gap-3">
            <div className="pt-0.5">
              <input
                type="text" inputMode="decimal"
                defaultValue={codeOf(o) ?? ''}
                placeholder="순번"
                onBlur={e => { const v = e.target.value; if (v !== String(codeOf(o) ?? '')) saveCode(o, v); }}
                disabled={saving === o.id}
                className={`w-14 px-1.5 py-1 border rounded-lg text-sm text-center font-bold outline-none focus:border-amber-400 disabled:opacity-50 ${
                  codeOf(o) === null ? 'border-red-300 bg-red-50 text-red-700' : 'border-stone-200'}`}
              />
            </div>
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
                  .filter(x => x.q > 0).map(x => `${menuLabel(x.m)} ${x.q}`).join(' / ')}
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
// ⚠️ 전에는 선결제·정기 손님만 보여줬다(prepaid_balance > 0 || is_regular). 그래서 일반 손님은
// 목록에 아예 없었고, 이름을 고칠 방법도 없었다. 조리표 이름은 카카오 채널에 저장해 둔 이름과
// 같아야 맞춰볼 수 있는데(동명이인은 카톡에 '찬희2'로 저장) 고칠 데가 없었던 것.
// 전체를 다 그리면 느려지니, 선결제·정기는 늘 보여주고 나머지는 검색했을 때만 나온다.
function CustomerManager({ customers, onUpdate }: { customers: Customer[]; onUpdate: (c: Customer[]) => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const prepaid = customers.filter(c => c.prepaid_balance > 0 || c.is_regular);

  // 손님은 계속 쌓이므로 화면에 다 들고 있지 않는다 — 찾는 건 서버가 한다.
  // (전부 받아다 걸렀더니 1000명 뒤의 손님은 검색해도 안 나왔다)
  const [found, setFound] = useState<Customer[]>([]);
  const [finding, setFinding] = useState(false);
  const term = q.trim();

  useEffect(() => {
    if (!term) { setFound([]); return; }
    let alive = true;
    const t = setTimeout(async () => {
      setFinding(true);
      try {
        const d = await fetch(`/api/customers?q=${encodeURIComponent(term)}`).then(r => r.json());
        if (alive) setFound(d.customers || []);
      } catch { if (alive) setFound([]); }
      if (alive) setFinding(false);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [term]);

  async function saveName(c: Customer, name: string) {
    const next = name.trim().slice(0, 20);
    if (!next || next === c.baby_name) return;
    setSavingId(c.id);
    try {
      const r = await fetch('/api/customers', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.id, baby_name: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setMsg(`못 고쳤어요: ${d.error || r.status}`);
      } else {
        onUpdate(customers.map(x => x.id === c.id ? { ...x, baby_name: next } : x));
        setFound(prev => prev.map(x => x.id === c.id ? { ...x, baby_name: next } : x));
        setMsg(
          d.ordersError
            ? `이름은 ${next}(으)로 바뀌었는데 주문 쪽이 안 바뀌었어요 — ${d.ordersError}`
            : `${d.was} → ${next} · 주문 ${d.ordersUpdated}건도 같이 바뀌었어요`
        );
      }
    } catch (e: any) {
      setMsg(`못 고쳤어요: ${e?.message || '네트워크 오류'}`);
    }
    setSavingId(null);
    setTimeout(() => setMsg(null), 6000);
  }

  const nameInput = (c: Customer) => (
    <input
      key={c.id + c.baby_name}
      defaultValue={c.baby_name}
      disabled={savingId === c.id}
      onBlur={e => saveName(c, e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      maxLength={20}
      title="눌러서 고칠 수 있어요 (카톡에 저장한 이름과 같게)"
      className="font-bold text-stone-900 bg-transparent border border-transparent rounded px-1 -ml-1
                 hover:border-stone-200 focus:border-amber-400 focus:bg-white outline-none disabled:opacity-50"
      style={{ width: `${Math.max(4, (c.baby_name || '').length + 2)}ch` }}
    />
  );

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

      {/* 이름 고치기 — 카톡 이름과 맞추는 자리 */}
      <div className="mb-4 bg-white rounded-xl border border-stone-200 p-4">
        <p className="text-xs text-stone-500 mb-2 leading-relaxed">
          아기 이름을 <b>눌러서 바로 고칠 수</b> 있어요. 고치면 <b>그 집 주문 이름도 같이 바뀝니다</b> — 조리표·주소록에 그대로 찍혀요.
          동명이인은 카톡에 저장해 두신 대로 <b>찬희2·찬희3</b> 처럼 적으시면 됩니다.
        </p>
        <input value={q} onChange={e => setQ(e.target.value)}
          placeholder="이름 또는 번호로 찾기"
          className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none" />
        {term && (
          <div className="mt-2">
            <p className="text-[11px] text-stone-400 mb-1">{finding ? '찾는 중…' : `${found.length}명`}</p>
            <div className="max-h-80 overflow-auto divide-y divide-stone-100 border border-stone-200 rounded-lg">
              {!finding && found.length === 0 && <p className="px-3 py-3 text-sm text-stone-400">그런 손님이 없어요</p>}
              {found.map(c => (
                <div key={c.id} className="px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    {nameInput(c)}
                    <span className="ml-2 text-xs text-stone-500">{formatPhone(c.phone)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {c.is_regular && <span className="text-[10px] bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">정기</span>}
                    {c.prepaid_balance > 0 && <span className="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">잔여 {c.prepaid_balance}</span>}
                  </div>
                </div>
              ))}
            </div>
            {found.length >= 80 && <p className="mt-1 text-[11px] text-stone-400">80명까지만 보여드려요 — 더 좁혀서 찾아주세요</p>}
          </div>
        )}
      </div>

      <h3 className="text-sm font-bold text-stone-700 mb-2">선결제 · 정기 손님</h3>
      {prepaid.length === 0 && <Empty text="선결제·정기 손님이 없어요" />}
      <div className="space-y-3">
        {prepaid.map(c => (
          <div key={c.id} className="bg-white rounded-xl border border-stone-200 p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                {nameInput(c)}
                <span className="ml-2 text-xs text-stone-500">{formatPhone(c.phone)}</span>
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

  const shown = reviews.filter(r => r.is_approved).length;
  return (
    <div className="space-y-3">
      <AskForReviews />
      {reviews.length === 0 ? <Empty text="아직 등록된 후기가 없어요" /> : <>
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
      </>}
    </div>
  );
}

// ── 후기 부탁하기 ────────────────────────────────────────────────
// 후기를 쓸 자리는 다 있는데(작성 화면·1,000P·승인) 아무도 "써주세요" 라고 말하지 않아서
// 후기가 1개였다. 배송 3일 뒤에 묻는 크론(/api/cron/review-ask)을 만들었지만,
// 세어보니 부탁할 손님 42명 중 푸시로 닿는 사람이 0명이었다 — 알림을 켠 사람이 없다.
// 그래서 지금 열려 있는 통로를 둔다: 연락처. 문구를 복사해 직접 보내는 방식.
// 보내는 일은 사람이 한다 — 코드가 손님에게 먼저 말을 걸지 않게.
//
// ⚠️ 명단에 시험용 주문이 섞인다. 운영 DB를 세어보니 주문 120건 중 대부분이
// 번호 끝자리 0001~0011, 1000~1029 로 이어지는 시험 데이터였고(하루에 56건이
// 한꺼번에 들어갔다), 실제로 계속 주문하시는 분은 정기배송 한 분뿐이었다.
// 그래서 코드가 "이건 가짜" 라고 판단해 걸러내지는 않는다 — 번호 모양으로
// 짐작해 지우다가 실제 손님을 날린 적이 있다. 누가 진짜인지는 사장님이 아신다.
// 화면에 그 사실을 적어두고, 고르는 일은 사람에게 맡긴다.
type ReviewTarget = { phone: string; babyName: string; orders: number; lastDelivery: string; pushable: boolean };
type TargetSummary = { customers: number; alreadyWrote: number; toAsk: number; repeat: number; reachableByPush: number };

function AskForReviews() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ targets: ReviewTarget[]; summary: TargetSummary } | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const d = await fetch('/api/admin/review-targets').then(r => r.json());
      if (d.ok) setData({ targets: d.targets, summary: d.summary });
    } catch {}
    setLoading(false);
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data) load();
  }

  // 보낼 문구. 아이 이름을 넣어 "우리 집에 보낸 말" 로 읽히게 한다.
  function msg(t: ReviewTarget) {
    return `${t.babyName} 부모님, 까꿍디미방입니다.\n`
      + `${withSubject(t.babyName)} 이유식 잘 먹었는지 궁금해요.\n`
      + `앱에 한 줄만 남겨주시면 다음 주문에 쓰실 수 있는 1,000포인트 드려요.\n`
      // 가게 주소로 보낸다. vercel.app 주소는 손님 눈에 우리 가게로 읽히지 않고,
      // 문자·카톡에서 낯선 도메인으로 보여 안 눌리거나 스팸으로 걸릴 수 있다.
      // app/layout.tsx·sitemap.ts 가 쓰는 주소와 같은 것으로 맞춘다.
      + `https://kkdmb.picolab.kr/order`;
  }

  async function copy(t: ReviewTarget) {
    try {
      await navigator.clipboard.writeText(msg(t));
      setCopied(t.phone);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // 클립보드가 막힌 브라우저(또는 http) 에서도 보낼 수 있어야 한다
      alert(msg(t));
    }
  }

  return (
    <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
      <button onClick={toggle} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <span className="font-bold text-stone-900 text-sm">
          후기 부탁하기
          {data && <span className="ml-2 font-normal text-amber-700">{data.summary.toAsk}명</span>}
        </span>
        <span className="text-stone-400 text-xs">{open ? '접기' : '열기'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-stone-100 pt-3">
          {loading && <div className="text-center py-6 text-stone-400 text-sm">세는 중…</div>}
          {!loading && !data && <div className="text-sm text-stone-500 py-4">명단을 불러오지 못했어요.</div>}
          {!loading && data && (
            <>
              <div className="text-xs text-stone-500 mb-3 leading-relaxed">
                배송 받아본 손님 {data.summary.customers}명 · 이미 쓰신 분 {data.summary.alreadyWrote}명 ·
                두 번 이상 주문 {data.summary.repeat}명
                <span className="block mt-1 text-stone-400">
                  {data.summary.reachableByPush === 0
                    ? '알림(푸시)을 켜 둔 손님이 없어서, 자동 알림은 아직 아무에게도 가지 않습니다. 아래에서 직접 보내주세요.'
                    : `이 중 ${data.summary.reachableByPush}명은 배송 3일 뒤 자동 알림으로도 부탁이 갑니다.`}
                </span>
                <span className="block mt-1 text-stone-400">최근에 받으신 분이 위에 있습니다 — 맛이 아직 기억에 남아 있는 분들입니다.</span>
              </div>
              <div className="text-[11px] text-stone-500 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 mb-3 leading-relaxed">
                주문 기록에서 그대로 뽑은 명단이라 <b>시험용으로 넣은 주문도 함께 보입니다.</b>
                번호를 보고 실제 손님인지 확인한 뒤에 보내주세요.
              </div>

              {data.targets.length === 0 ? (
                <div className="text-sm text-stone-500 py-3">부탁할 분이 없어요. 모두 이미 써주셨습니다.</div>
              ) : (
                <div className="space-y-2">
                  {data.targets.map(t => (
                    <div key={t.phone} className="flex items-center justify-between gap-2 border border-stone-200 rounded-lg px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-stone-900 truncate">
                          {t.babyName} 부모님
                          {t.orders >= 2 && <span className="ml-1.5 text-[11px] font-normal text-amber-700">{t.orders}번 주문</span>}
                        </div>
                        <div className="text-[11px] text-stone-400">
                          {formatPhone(t.phone)} · 마지막 배송 {t.lastDelivery}
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <button onClick={() => copy(t)}
                          className="text-[11px] px-2.5 py-1.5 rounded-lg border border-amber-200 text-amber-700 font-bold whitespace-nowrap hover:bg-amber-50">
                          {copied === t.phone ? '복사됐어요' : '문구 복사'}
                        </button>
                        <a href={`sms:${t.phone}?body=${encodeURIComponent(msg(t))}`}
                          className="text-[11px] px-2.5 py-1.5 rounded-lg border border-stone-200 text-stone-600 font-bold whitespace-nowrap hover:bg-stone-50">
                          문자
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
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
      <p className="text-xs text-stone-400 mt-3 text-center">컬럼: 조리일·아기이름·개월수·단계·용량·한우·닭·기타·총팩수·총금액·주소·연락처·상태</p>
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
          <div className="text-xs text-stone-400 mb-1">오늘 접수 매출</div>
          <div className="text-xl font-black text-stone-900">{stats.today.revenue.toLocaleString()}원</div>
          <div className="text-[11px] text-stone-400 mt-0.5">주문 {stats.today.orders}건</div>
        </div>
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <div className="text-xs text-stone-400 mb-1">이번 달 접수 매출</div>
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
