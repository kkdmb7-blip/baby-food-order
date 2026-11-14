'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Order, Customer, WeeklyMenu, OrderStatus, MenuType } from '@/lib/supabase';
import { MENU_TYPES, STAGES, STAGE_OPTIONS, PREPAID_UNITS, prepaidPrice, menuLabel } from '@/lib/supabase';
import { formatPhone, fmtDateTime } from '@/lib/dates';
import { withSubject } from '@/lib/korean';
import { slicesOn, qtyOn, orderDates } from '@/lib/orderItems';
import { routeCodeOf, routeCodeFor, addrKey, legacyAddrKey, looksDirectDelivery, nearRouteCodeOf } from '@/lib/routeCode';
import GridEntry from './GridEntry';
import DepositTab from './DepositTab';
import ChargeBar from './ChargeBar';
import SheetEditor from './SheetEditor';
import CookingTable from './CookingTable';
import { buildCookingSheet } from '@/lib/cookingSheet';
import { isSplit, partsOf, balanceFor, shortKind } from '@/lib/prepaidSplit';
import { AddMissing } from './InlineAdd';
import { defaultArrivalNote } from '@/lib/arrival';
import { sortBanchanNames } from '@/lib/banchanOrder';
import { parseKakaoPrepaid } from '@/lib/kakaoPrepaid';

// '카톡주문' 탭은 뺐다 — 주문접수(조리표 탭) 맨 위에서 붙여넣으면 바로 읽어 채우므로
// 같은 일을 두 군데서 하게 된다. 컴포넌트(KakaoOrderEntry.tsx)는 남겨 뒀다.
type Tab = '주문' | '입금' | '통계' | '배송' | '조리표' | '주소록' | '메뉴관리' | '고객관리' | '후기' | '엑셀';
// '메뉴관리' 탭은 뺐다(2026-11-14) — 그 표(baby_food_weekly_menus)는 한 번도 안 쓰였고, 메뉴는 메뉴 프로그램
// (kkakung_history)이 원본이다. 거기 저장하면 손님 주문 화면(/api/menus/current)이 그걸 먼저 보여 메뉴가 어긋난다.
const TABS: Tab[] = ['주문', '입금', '통계', '배송', '조리표', '주소록', '고객관리', '후기', '엑셀'];
const TAB_KEY = 'kkdmb-admin-tab';

// 미입금 = 입금확인도 안 됐고, '대조안함'(엑셀 시절 지난 주문 — 대조할 입금내역이 없음)도 아닌 주문
const isUnpaid = (o: Order) => !o.paid && o.order_type !== '선결제' && !o.paid_note;

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

/** 그 날짜가 든 주의 월~금 */
function weekDaysOf(date: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();   // 일=0
  const mon = shiftDay(date, dow === 0 ? -6 : 1 - dow);
  return [0, 1, 2, 3, 4].map(i => shiftDay(mon, i));
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

  // 고른 주문 모두에 기본 도착 안내를 남긴다(배송완료로도 바뀐다). 한 집씩 다른 말은 주문 카드에서.
  async function bulkArrive() {
    const ids = [...picked];
    if (ids.length === 0) return;
    if (!confirm(`${ids.length}건에 도착 안내를 남길까요? (배송완료로도 바뀌어요)`)) return;
    const results = await Promise.all(ids.map(id => fetch(`/api/orders/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arrive: true }),
    }).then(r => r.json()).catch(() => ({ ok: false }))));
    const failed = results.filter(r => !r.ok).length;
    setPicked(new Set());
    if (failed) alert(`${ids.length - failed}건 보냄 · ${failed}건 실패 (취소된 주문이거나 연결 오류)`);
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
    // 입금 대조로 확인된 걸 끄면 그 근거가 사라진다 — 한 번 묻는다
    if (!next && o.paid_note?.startsWith('입금 ') && !confirm(`${o.paid_note}\n\n이 입금확인을 끌까요? (입금 탭의 짝은 그대로 남아요)`)) return;
    setOrders(prev => prev.map(x => x.id === o.id ? { ...x, paid: next } : x));
    const d = await fetch(`/api/orders/${o.id}/paid`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: next }),
    }).then(r => r.json()).catch(() => ({ ok: false }));
    // 실패하면 되돌림 — 입금 상태가 화면과 DB에서 달라지면 대조가 무의미해짐
    if (!d.ok) setOrders(prev => prev.map(x => x.id === o.id ? { ...x, paid: !next } : x));
    else setOrders(prev => prev.map(x => x.id === o.id ? { ...x, paid_note: d.paid_note ?? null } : x));
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
              {String(s.stage || '').startsWith('반찬')
                // 반찬은 손님 메뉴표와 같은 번호 순서로 (lib/banchanOrder)
                ? <>{s.stage}:[{sortBanchanNames((s.menus||[]).filter((m:any)=>m.qty>0).map((m:any)=>({ ...m, name: m.menu }))).map((m:any)=>`${m.menu} ${m.qty}`).join('·')}]{' '}</>
                : <>{s.stage} {s.volume}g:[{(s.menus||[]).filter((m:any)=>m.qty>0).map((m:any)=>`${m.menu} ${m.qty}`).join('·')}]{' '}</>}
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
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="font-bold text-stone-900 flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-sm.png" alt="까꿍디미방" width={30} height={30} className="w-[30px] h-[30px] object-contain" />
            이유식 관리 <span className="text-sm text-stone-400 font-normal">{today}</span>
          </h1>
          <button onClick={logout} className="text-xs text-stone-500 px-3 py-1.5 border border-stone-200 rounded-lg">
            로그아웃
          </button>
        </div>

        {/* 조리일 선택 — 기본은 오늘, 다른 날은 직접 골라서 본다.
            (주문은 항상 "내일 이후" 조리분이라 오늘만 볼 수 있으면 확인이 안 됐음) */}
        {/* 조리일 — 날짜를 입력칸에 치는 게 아니라 그 주 월~금을 펼쳐 놓고 누른다.
            화살표는 한 주씩 옮긴다. 조리는 월·화·목·금(이유식)과 수(반찬)에만 하므로
            주말은 올리지 않는다. */}
        <div className="max-w-6xl mx-auto px-4 pb-2 flex items-center gap-1.5">
          <button onClick={() => router.push(`/admin?date=${shiftDay(selectedDate, -7)}`)} aria-label="지난 주"
            title="지난 주"
            className="px-2 py-1.5 rounded-lg border-2 border-stone-300 bg-white text-stone-700 text-base font-black leading-none hover:bg-stone-50">
            ‹‹
          </button>
          {weekDaysOf(selectedDate).map(d => {
            const on = d === selectedDate;
            const isToday = d === today;
            const dow = DOW_KO[new Date(d + 'T00:00:00Z').getUTCDay()];
            return (
              <button key={d} onClick={() => router.push(`/admin?date=${d}`)}
                className={`px-2.5 py-1.5 rounded-lg border-2 text-sm leading-none whitespace-nowrap ${
                  on ? 'border-amber-500 bg-amber-500 text-white font-black'
                     : isToday ? 'border-amber-300 bg-white text-amber-800 font-bold'
                     : 'border-stone-200 bg-white text-stone-600 font-bold hover:bg-stone-50'}`}>
                {Number(d.slice(8, 10))}<span className="ml-0.5">{dow}</span>
              </button>
            );
          })}
          <button onClick={() => router.push(`/admin?date=${shiftDay(selectedDate, 7)}`)} aria-label="다음 주"
            title="다음 주"
            className="px-2 py-1.5 rounded-lg border-2 border-stone-300 bg-white text-stone-700 text-base font-black leading-none hover:bg-stone-50">
            ››
          </button>
          <span className="text-[11px] text-stone-400 ml-0.5">{selectedDate.slice(0, 7).replace('-', '. ')}</span>
          {selectedDate !== today && (
            <button onClick={() => router.push('/admin')}
              className="text-xs text-amber-700 font-bold underline underline-offset-2 ml-1">오늘</button>
          )}
        </div>
        <div className="max-w-6xl mx-auto px-4 flex gap-1 pb-0 overflow-x-auto no-scrollbar">
          {tabs.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${tab === t ? 'border-amber-500 text-amber-700' : 'border-transparent text-stone-500 hover:text-stone-700'}`}>
              {t}
              {t === '주문' && <span className="ml-1 text-xs bg-amber-100 text-amber-700 px-1.5 rounded-full">{orders.filter(o=>o.status!=='취소').length}</span>}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5">
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
                        {isUnpaid(o) && <span className="ml-1 text-rose-600 font-bold">미입금</span>}
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div className="text-sm font-bold text-stone-700 flex items-center gap-2 flex-wrap">
              <span>{selectedDate} 조리분 <span className="text-amber-700">{orders.length}건</span></span>
              {(() => {
                const unpaid = orders.filter(o => isUnpaid(o));
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
                  : f === '미입금' ? orders.filter(o => isUnpaid(o)).length
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
                <button onClick={bulkArrive} className="text-xs px-2.5 py-1 bg-emerald-500/40 rounded-lg font-bold">도착 안내 보내기</button>
                <button onClick={() => setPicked(new Set())} className="text-xs px-2 py-1 ml-auto opacity-70">선택 해제</button>
              </div>
            )}

            {orders.length === 0 && (
              <Empty text={`${selectedDate}에 조리할 주문이 없어요`} />
            )}
            {orders.filter(o =>
              filter === '전체' ? true
              : filter === '미입금' ? (isUnpaid(o))
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
                  <button onClick={() => togglePaid(o)} title={o.paid_note || ''}
                    className={`ml-2 text-[11px] px-2 py-0.5 rounded-full border font-bold ${
                      o.paid ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
                      : o.paid_note ? 'bg-stone-100 text-stone-500 border-stone-200'
                             : 'bg-rose-100 text-rose-700 border-rose-200'}`}>
                    {o.paid ? '입금확인' : o.paid_note?.startsWith('오픈월드') ? '오픈월드' : o.paid_note ? '대조안함' : '미입금'}
                  </button>
                  {/* 입금 근거 — 어느 입금으로 확인했는지(자동/사장님) */}
                  {o.paid_note && <div className="text-[10px] text-stone-400 mt-0.5">{o.paid_note}</div>}
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
                {(o.status === '배송중' || o.status === '배송완료') && (
                  <ArrivalBox order={o} onSent={(note, at) => setOrders(prev => prev.map(x =>
                    x.id === o.id ? { ...x, status: '배송완료', arrival_note: note, arrived_at: at } : x))} />
                )}
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

        {tab === '입금' && <DepositTab dayOrders={orders as any} date={selectedDate} customers={customers} onTogglePaid={togglePaid}
          onPatch={(orderId, p) => {
            if (orderId && p.order) setOrders(prev => prev.map(x => x.id === orderId ? { ...x, ...(p.order as any) } : x));
            if (p.customerId && p.customer) setCustomers(prev => prev.map(c => c.id === p.customerId ? { ...c, ...p.customer } : c));
          }}
          onAdded={row => setOrders(prev => [row as Order, ...prev])} />}
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
              onChanged={() => router.refresh()}
              onAdded={row => setOrders(prev => [row as Order, ...prev])} />
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

function CookingSheet({ orders, today, customers, onChanged, onAdded }: {
  orders: Order[]; today: string; customers: Customer[]; onChanged: () => void;
  onAdded: (row: any) => void; // 단계 아래 추가 줄로 넣은 주문 — 입금 탭과 같은 주문 목록에 꽂는다
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

  // 화면 조리표도 종이 조리표와 같은 표를 쓴다(CookingTable) — 전에는 따로 그려져서
  // 담는 사람이 보는 숫자가 두 모양이었다. 계산은 lib/cookingSheet.ts 한 곳에서 한다.
  const sheet = buildCookingSheet(orders as any, today, printInfo?.printedAt ?? null);

  return (
    <div>
      <div className="mb-4 no-print">
        <div className="flex gap-2 flex-wrap">
          <button onClick={printAll}
            className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-bold">
            🖨 조리표 프린트
          </button>
          {/* 담는 쪽은 "누가 뭘 먹는지"가 아니라 "단계·용량별 몇 개"만 보면 된다.
              엑셀에서도 '조리갯수' 시트를 따로 뽑아 담는 대에서 쓰고 계셨다. */}
          <button onClick={() => window.open(`/admin/print/tally?date=${today}`, '_blank')}
            className="px-4 py-2 bg-white border-2 border-stone-400 text-stone-700 rounded-lg text-sm font-bold">
            📋 담는 수량 프린트
          </button>
          {/* 포장한 봉투에 잘라 붙이는 이름 — 엑셀 '이유식이름' 시트와 같은 크기 */}
          <button onClick={() => window.open(`/admin/print/names?date=${today}`, '_blank')}
            className="px-4 py-2 bg-white border-2 border-stone-400 text-stone-700 rounded-lg text-sm font-bold">
            이름표 프린트
          </button>
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

      {/* 종이에 나가는 것과 같은 표. 이름을 누르면 그 사람 것을 고친다. */}
      <div className="bg-white rounded-xl border border-stone-200 p-4 overflow-x-auto">
        <div className="flex items-baseline gap-2 flex-wrap mb-2 text-[13px]">
          <span className="text-base font-black text-stone-900">
            조리 {Number(today.slice(5, 7))}/{Number(today.slice(8, 10))}({DOW_KO[new Date(today + 'T00:00:00Z').getUTCDay()]})
          </span>
          <span className="font-bold text-stone-700">
            {sheet.people}명 · {sheet.totalPacks}팩
            {sheet.banchanTotal > 0 && ` · 반찬 ${sheet.banchanTotal}세트`}
            {sheet.banchanSingleTotal > 0 && ` · 낱개 ${sheet.banchanSingleTotal}개`}
          </span>
          {MENU_TYPES.map(m => (
            <span key={m} className="text-stone-600">{menuLabel(m)} <strong>{sheet.menuTotals[m]}</strong></span>
          ))}
          {sheet.unspecTotal > 0 && (
            <span className="text-rose-700 font-bold">미지정 {sheet.unspecTotal}팩</span>
          )}
          <span className="text-stone-400">
            <span className="text-red-600 font-bold">빨강</span>=큰용량 · 이름을 누르면 고칠 수 있어요
          </span>
        </div>

        {sheet.people === 0 && sheet.banchan.length === 0
          ? <div className="text-center text-stone-400 text-sm py-6">이 날짜에 조리할 주문이 없어요</div>
          : <CookingTable sheet={sheet}
                          onPick={ph => setEditPhone(p => (p === ph ? null : ph))}
                          onSaved={onChanged}
                          add={{ date: today, onAdded }}
                          printedAt={printInfo?.printedAt ?? null} />}
        {/* 그날 주문이 없는 단계에 넣을 때 — 단추를 누르면 빈 표가 열린다 */}
        <AddMissing sheet={sheet} date={today} onAdded={onAdded} />

        {/* 고치는 중인 사람 — 표 아래에 펼친다 */}
        {editPhone && (
          <SheetEditor
            date={today}
            orders={orders.filter(o => o.customer_phone === editPhone)}
            customers={customers}
            onClose={() => setEditPhone(null)}
            onChanged={onChanged}
          />
        )}
      </div>
    </div>
  );
}

// ── 주소록 ────────────────────────
// ── 배송 구역별 묶음 (두발히어로 기사 전달용) ──────────
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
    o.delivery_method !== '택배익일배송' &&
    // 구를 빼고 적어 보내는 주소("서울 등촌로 195")도 잡아야 한다 — 배송 순번표로 확인
    (o.delivery_method === '직배송' || looksDirectDelivery(`${o.address || ''} ${o.address_detail || ''}`))
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

  // 저장한 순번(새 키·옛 키) → 엑셀에서 그 손님(이름+주소)에게 매긴 번호 → 주소만으로 — 인쇄물과 같은 순서
  const codeOf = (o: Order): number | null => {
    const addr = String(o.address || '');
    for (const k of [addrKey(addr), legacyAddrKey(addr)]) if (k && overrides[k] !== undefined) return overrides[k];
    return routeCodeFor(o.baby_name, addr);
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

  // 순번대로 정렬 — 인쇄물과 같은 순서로 보이게. 순번이 없는 주소는 같은 길·동의 가까운 번지 순번으로 근처에 둔다
  const sortCode = (o: Order) => codeOf(o) ?? nearRouteCodeOf(String(o.address || ''), o.baby_name).code;
  const sorted = [...orders].sort((a, b) => {
    const ca = sortCode(a), cb = sortCode(b);
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
  // 검색해서 뭔가 고친 손님은 아래 목록에 카드로 남긴다 (사장님: "정보 변경하면 아래 석하린·송다민처럼 보여야")
  const [touched, setTouched] = useState<Set<string>>(new Set());

  /* 손님 전부를 ㄱㄴ순으로 (2026-11-14 사장님: "고객 이름을 전부 띄워줘").
     3개월(90일) 넘게 주문이 없으면 아래 '쉬는 손님' 으로 따로 — 주문이 생기면 마지막 주문일이 바뀌어
     저절로 위로 돌아온다(따로 표시를 저장하지 않고 열 때마다 계산한다).
     정기배송·선결제가 남은 손님은 주문이 뜸해도 위에 둔다 — 아직 관계가 이어지는 손님이다. */
  const [allLoaded, setAllLoaded] = useState<'loading' | 'ok' | string>('loading');
  useEffect(() => {
    fetch('/api/customers?all=1').then(r => r.json())
      .then(d => { if (Array.isArray(d.customers)) { onUpdate(d.customers); setAllLoaded('ok'); } else setAllLoaded(d.error || '불러오지 못했어요'); })
      .catch(e => setAllLoaded(e?.message || '불러오지 못했어요'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cutoff = new Date(Date.now() + 9 * 3600e3 - 90 * 864e5).toISOString().slice(0, 10);
  const byName = (a: Customer, b: Customer) => (a.baby_name || '').localeCompare(b.baby_name || '', 'ko');
  const isActive = (c: Customer) =>
    c.is_regular || c.prepaid_balance > 0 || (c.prepaid_banchan || 0) > 0 || touched.has(c.id)
    || (!!c.last_order && c.last_order >= cutoff)
    || (allLoaded === 'ok' && c.last_order === undefined); // 방금 새로 생긴 손님(목록 받은 뒤 추가됨)
  // 선결제가 남은(또는 받을 팩이 있는) 손님은 맨 위에 따로 — 사장님: "선결제한 사람들은 위로 모으자"
  const hasPrepaid = (c: Customer) => c.prepaid_balance !== 0 || (c.prepaid_banchan || 0) > 0 || isSplit(c);
  const prepaidList = customers.filter(hasPrepaid).sort(byName);
  const activeList = customers.filter(c => !hasPrepaid(c) && isActive(c)).sort(byName);
  const dormant = customers.filter(c => !hasPrepaid(c) && !isActive(c)).sort(byName);
  const [showDormant, setShowDormant] = useState(true);

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
        patchCustomer(c.id, { baby_name: next });
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

  // 너비: ch 는 숫자 '0' 너비라 한글(약 2ch)은 절반만 보였다(세 글자 이름이 두 글자로 잘림) → 글자 수 × 1em + 여백
  const nameInput = (c: Customer) => (
    <input
      key={c.id + c.baby_name}
      defaultValue={c.baby_name}
      disabled={savingId === c.id}
      onBlur={e => saveName(c, e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      maxLength={20}
      title="눌러서 고칠 수 있어요 (카톡에 저장한 이름과 같게)"
      className="text-[14px] font-bold text-stone-900 bg-transparent border border-transparent rounded px-1 -ml-1
                 hover:border-stone-200 focus:border-amber-400 focus:bg-white outline-none disabled:opacity-50"
      style={{ width: `calc(${Math.max(2, (c.baby_name || '').length)}em + 1.2rem)` }}
    />
  );

  // 충전 중엔 단추를 잠근다 — 두 번 눌려 두 번 충전되는 걸 막는다
  const [chargingId, setChargingId] = useState<string | null>(null);
  const [openLedger, setOpenLedger] = useState<string | null>(null);

  // 잔여가 바뀌면 목록·검색결과 둘 다 맞춘다. 0에서 처음 넣은 손님은 아래 선결제 목록에 새로 뜬다.
  function setBalance(id: string, n: number) { patchCustomer(id, { prepaid_balance: n }); }
  // 손님 한 명의 값이 바뀌면 목록·검색결과 둘 다 맞춘다 (잔여·반찬 회수·단계 표시·정기배송)
  // 오픈월드(나라 후원사업) 켜고 끄기 — 켜면 이 집의 입금 안 된 주문이 입금 대조에서 빠진다
  async function toggleOpenworld(c: Customer) {
    const next = !c.openworld;
    if (!confirm(next
      ? `${c.baby_name} — 오픈월드(후원사업) 아이로 표시할까요?\n입금 안 된 주문이 입금 대조에서 빠지고, 앞으로 들어오는 주문도 자동으로 빠집니다.`
      : `${c.baby_name} — 오픈월드 표시를 뺄까요?\n오픈월드로 빼 두었던 주문이 다시 미입금으로 잡힙니다.`)) return;
    setSavingId(c.id);
    const r = await fetch('/api/customers', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.id, openworld: next }),
    }).then(x => x.json()).catch(() => ({}));
    setSavingId(null);
    if (!r.ok) { setMsg(`못 바꿨어요: ${r.error || ''}`); return; }
    patchCustomer(c.id, { openworld: next });
    setMsg(`${c.baby_name} — ${next ? '오픈월드로 표시' : '오픈월드 표시 뺌'} (주문 ${r.orders}건 같이 바뀜)`);
  }

  function patchCustomer(id: string, patch: Partial<Customer>) {
    setTouched(s => s.has(id) ? s : new Set(s).add(id));
    const inList = customers.some(c => c.id === id);
    const hit = found.find(x => x.id === id);
    onUpdate(inList
      ? customers.map(c => c.id === id ? { ...c, ...patch } : c)
      : hit ? [...customers, { ...hit, ...patch }] : customers);
    setFound(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
  }

  // 할인표(간판)로 받을 돈을 같이 띄우고, 장부에 금액까지 남긴다 — 입금 대조가 그 금액으로 맞춘다
  async function charge(id: string, units: typeof PREPAID_UNITS[number], label?: string | null) {
    if (chargingId) return;
    const won = prepaidPrice(label, units);
    if (!confirm(won
      ? `${label} ${units}팩 — ${won.toLocaleString()}원 받으셨나요?
(간판 할인표 금액, 장부에 같이 남습니다)`
      : `${units}팩을 넣을까요?
(선결제 단계가 비어 있어 금액은 안 남습니다 — 기록 보기에서 단계를 먼저 고르시면 금액도 남아요)`)) return;
    setChargingId(id);
    try {
      const r = await fetch(`/api/customers/${id}/prepaid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ units, amount_won: won || undefined, label: label || undefined })
      });
      const d = await r.json().catch(() => ({}));
      if (d.ok) {
        // 고른 종류(단계·용량)를 손님 표시에도 남긴다 — 서버도 같이 저장한다
        // 다른 종류로 충전하면 묶음이 따로 생긴다(후기230 + 완료기230) — 서버가 돌려준 묶음으로 맞춘다
        patchCustomer(id, { prepaid_balance: d.new_balance, prepaid_split: d.split ?? null, ...(d.label || label ? { prepaid_label: d.label || label } : {}) });
        setMsg(`${label ? label + ' ' : ''}${units}팩 충전됐어요 (${d.split ? `${label} 묶음 ${d.part}팩 · 합계 ` : '잔여 '}${d.new_balance}팩)`);
        const open = openLedger;
        if (open === id || open === 'f:' + id) { setOpenLedger(null); setTimeout(() => setOpenLedger(open), 0); }
      } else {
        setMsg(`오류: ${d.error || r.status}`);
      }
    } catch (e: any) {
      setMsg(`오류: ${e?.message || '네트워크 오류'}`);
    }
    setChargingId(null);
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
                <div key={c.id} className="px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    {nameInput(c)}
                    <span className="ml-2 text-xs text-stone-500">{c.phone ? formatPhone(c.phone) : "연락처 없음"}</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {c.is_regular && <span className="text-[10px] bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">정기</span>}
                    {c.prepaid_balance > 0 && <span className="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">잔여 {c.prepaid_balance}{c.prepaid_label ? ` · ${c.prepaid_label}` : ''}</span>}
                    {(c.prepaid_banchan || 0) > 0 && <span className="text-[10px] bg-lime-100 text-lime-800 px-2 py-0.5 rounded-full">반찬 {c.prepaid_banchan}회</span>}
                    <button onClick={() => toggleOpenworld(c)} disabled={savingId === c.id}
                      title="나라 후원사업 아이 — 입금 대조에서 빼고, 나중에 한꺼번에 정산"
                      className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${c.openworld ? 'bg-sky-100 text-sky-800 border-sky-300' : 'border-stone-200 text-stone-400'}`}>
                      {c.openworld ? '오픈월드' : '오픈월드 아님'}
                    </button>
                    <button onClick={() => setOpenLedger(openLedger === 'f:' + c.id ? null : 'f:' + c.id)}
                      className="text-[10px] px-2 py-0.5 border border-stone-200 text-stone-600 rounded-full font-bold">
                      {openLedger === 'f:' + c.id ? '닫기' : '선결제·주문내역'}
                    </button>
                  </div>
                  {/* 검색으로 찾은 손님도 선결제를 넣고 주문 내역을 볼 수 있게 (잔여 0 손님은 아래 목록에 없다) */}
                  {openLedger === 'f:' + c.id && (
                    <div className="w-full">
                      <RegularEditor customer={c} onSaved={p => patchCustomer(c.id, p)} />
                      <div className="mt-2">
                        <ChargeBar label={c.prepaid_label} disabled={chargingId === c.id} onCharge={(u, l) => charge(c.id, u as any, l)} />
                      </div>
                      <PrepaidLedger key={c.id + ':' + c.prepaid_balance} customerId={c.id} balance={c.prepaid_balance} split={isSplit(c)} onBalance={n => setBalance(c.id, n)} onPatch={p => patchCustomer(c.id, p)} />
                    </div>
                  )}
                </div>
              ))}
            </div>
            {found.length >= 80 && <p className="mt-1 text-[11px] text-stone-400">80명까지만 보여드려요 — 더 좁혀서 찾아주세요</p>}
          </div>
        )}
      </div>

      {/* 한 줄 목록 (2026-11-14 사장님: "알아보기 쉽지 않아 — 한 줄로, 글씨 줄여서 한 화면에 많이,
          선결제한 사람은 위로, 남은 팩·반찬·보호자 이름은 화면에서 바로 수정")
          묶음: ① 선결제 남은 손님 ② 손님(3개월 안 주문·정기) ③ 쉬는 손님 — 각각 ㄱㄴ순.
          칸을 고치고 다른 데를 누르거나 Enter 를 치면 바로 저장된다. 팩·회수는 한 번 묻는다(장부에 남는 돈이라). */}
      <p className="text-[11px] text-stone-400 mb-2">
        {allLoaded === 'loading' ? '손님 전부 불러오는 중…' : allLoaded !== 'ok' ? `전부 불러오지 못했어요: ${allLoaded}` :
          '남은 팩·반찬·보호자 이름 칸은 바로 고쳐져요 (고치고 Enter). 충전(+20·30·50팩)과 기록은 「기록」에서.'}
      </p>
      {rowGroup(`선결제 남은 손님 ${prepaidList.length}명`, prepaidList, 'text-amber-800')}
      {rowGroup(`손님 ${activeList.length}명`, activeList, 'text-stone-700')}
      {dormant.length > 0 && (
        <>
          <button onClick={() => setShowDormant(v => !v)}
            className="mt-4 mb-1 w-full flex justify-between items-center text-[13px] font-bold text-stone-500">
            <span>쉬는 손님 {dormant.length}명 <span className="font-normal text-stone-400">3개월 넘게 주문 없음 · 주문하면 위로 돌아가요</span></span>
            <span>{showDormant ? '∧' : '∨'}</span>
          </button>
          {showDormant && rowGroup('', dormant, 'text-stone-500')}
        </>
      )}
    </div>
  );

  function rowGroup(title: string, list: Customer[], cls: string) {
    if (!list.length) return null;
    return (
      <div className="mb-4">
        {title && <h3 className={`text-[13px] font-bold mb-1 ${cls}`}>{title} <span className="font-normal text-stone-400">ㄱㄴ순</span></h3>}
        <div className="bg-white rounded-xl border border-stone-200 divide-y divide-stone-100">
          {list.map(c => customerRow(c))}
        </div>
      </div>
    );
  }

  // 팩·회수 칸 저장 — 장부(선결제 기록)에 '목록에서 바로 고침' 으로 남는다
  // part = 여러 단계 선결제 손님의 묶음 하나('완료기 230g') — 그 묶음 잔여만 고친다
  async function saveCount(c: Customer, kind: '팩' | '반찬', raw: string, el: HTMLInputElement, part?: string) {
    const cur = kind === '팩' ? (part ? balanceFor(c, part) : c.prepaid_balance) : (c.prepaid_banchan || 0);
    const t = raw.trim();
    const n = t === '' ? 0 : Number(t);
    if (n === cur) { el.value = cur ? String(cur) : ''; return; }
    if (!Number.isInteger(n) || (kind === '반찬' && n < 0)) { setMsg('숫자로 적어주세요'); el.value = cur ? String(cur) : ''; return; }
    if (!confirm(`${c.baby_name} — ${kind === '팩' ? `${part ? part + ' ' : ''}남은 팩 ${cur} → ${n}팩` : `반찬 선결제 ${cur} → ${n}회`}\n이대로 고칠까요?`)) { el.value = cur ? String(cur) : ''; return; }
    setSavingId(c.id);
    const d = await fetch(`/api/customers/${c.id}/prepaid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(kind === '팩' ? { set: n, memo: '목록에서 바로 고침', ...(part ? { kind: part } : {}) } : { item: '반찬', set: n, memo: '목록에서 바로 고침' }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e?.message }));
    setSavingId(null);
    if (!d.ok) { setMsg(`못 고쳤어요: ${d.error || ''}`); el.value = cur ? String(cur) : ''; return; }
    patchCustomer(c.id, kind === '팩' ? { prepaid_balance: d.new_balance, prepaid_split: d.split ?? null } : { prepaid_banchan: d.new_balance });
    setMsg(`${c.baby_name} — ${kind === '팩' ? `${part ? part + ' ' : ''}남은 팩 ${d.part ?? d.new_balance}팩` : `반찬 ${d.new_balance}회`}로 고쳤어요`);
  }

  async function savePayersInline(c: Customer, raw: string, el: HTMLInputElement) {
    const before = (c.payer_names || []).join(', ');
    if (raw.trim() === before.trim()) return;
    const list = raw.split(/[,\s·]+/).map(s => s.trim()).filter(Boolean);
    setSavingId(c.id);
    const r = await fetch('/api/customers', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.id, payer_names: list }),
    }).then(x => x.json()).catch(() => ({}));
    setSavingId(null);
    if (!r.ok) { setMsg(`못 고쳤어요: ${r.error || ''}`); el.value = before; return; }
    patchCustomer(c.id, { payer_names: r.payer_names || [] });
    setMsg(`${c.baby_name} — 보호자 이름 저장 (입금 대조가 이 이름으로도 찾아요)`);
  }

  function customerRow(c: Customer) {
    const enter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); };
    const busy = savingId === c.id;
    const bal = c.prepaid_balance;
    return (
      <div key={c.id} className="px-2 py-1 text-[12px]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="w-[80px] shrink-0 overflow-hidden">{nameInput(c)}</span>
          <span className="text-[11px] text-stone-400 w-[88px] whitespace-nowrap">{c.phone ? formatPhone(c.phone) : '연락처 없음'}</span>
          {c.is_regular && <span className="text-[10px] bg-violet-100 text-violet-700 px-1.5 rounded-full">정기</span>}
          <button onClick={() => toggleOpenworld(c)} disabled={busy}
            title="나라 후원사업 아이 — 입금 대조에서 빼고, 나중에 한꺼번에 정산"
            className={`text-[10px] px-1.5 rounded-full border ${c.openworld ? 'bg-sky-100 text-sky-800 border-sky-300 font-bold' : 'border-stone-200 text-stone-300'}`}>
            오픈월드
          </button>

          {isSplit(c) ? (
            // 여러 단계 선결제 — 묶음마다 칸 (사장님 2026-11-14: "후기230 이랑 완료기230 두 개 해두고 같이 주문하는 아이들")
            partsOf(c).map(p => (
              <label key={p.kind} className="flex items-center gap-0.5 text-stone-500" title={`${p.kind} 남은 팩 (마이너스 = 받을 팩)`}>
                <span className="text-[10px] font-bold text-stone-600">{shortKind(p.kind)}</span>
                <input key={`b${c.id}:${p.kind}:${p.balance}`} defaultValue={p.balance ? String(p.balance) : ''} placeholder="0" inputMode="numeric" disabled={busy}
                  onBlur={e => saveCount(c, '팩', e.target.value.replace(/[^\d-]/g, ''), e.target, p.kind)} onKeyDown={enter}
                  className={`w-9 px-1 py-0 border rounded text-right text-[12px] font-bold outline-none focus:border-amber-400 ${p.balance < 0 ? 'text-red-600 border-red-200' : p.balance <= 5 ? 'text-red-600 border-amber-200' : 'text-amber-700 border-amber-200'}`} />
                팩
              </label>
            ))
          ) : (
            <label className="flex items-center gap-0.5 text-stone-500" title="남은 이유식 선결제 팩 (마이너스 = 받을 팩)">
              남은
              <input key={`b${c.id}:${bal}`} defaultValue={bal ? String(bal) : ''} placeholder="0" inputMode="numeric" disabled={busy}
                onBlur={e => saveCount(c, '팩', e.target.value.replace(/[^\d-]/g, ''), e.target)} onKeyDown={enter}
                className={`w-10 px-1 py-0 border rounded text-right text-[12px] font-bold outline-none focus:border-amber-400 ${bal < 0 ? 'text-red-600 border-red-200' : bal > 0 ? (bal <= 5 ? 'text-red-600 border-amber-200' : 'text-amber-700 border-amber-200') : 'border-stone-200'}`} />
              팩<span className="inline-block w-[58px] text-[10px] text-stone-400 whitespace-nowrap">{c.prepaid_label || ''}</span>
            </label>
          )}
          {/* 마이너스 = 선결제보다 더 먹음 → 입금 요청 톡 보낼 손님 (사장님 2026-11-14). 여러 묶음이면 묶음마다 */}
          {partsOf(c).filter(p => p.balance < 0).map(p => (
            <span key={'m' + p.kind} className="text-[10px] font-black text-white bg-red-500 px-1.5 rounded-full whitespace-nowrap">
              입금요청 {isSplit(c) ? shortKind(p.kind) + ' ' : ''}{-p.balance}팩
            </span>
          ))}

          <label className="flex items-center gap-0.5 text-stone-500" title="반찬 선결제 남은 회수">
            반찬
            <input key={`k${c.id}:${c.prepaid_banchan || 0}`} defaultValue={c.prepaid_banchan ? String(c.prepaid_banchan) : ''} placeholder="0" inputMode="numeric" disabled={busy}
              onBlur={e => saveCount(c, '반찬', e.target.value.replace(/\D/g, ''), e.target)} onKeyDown={enter}
              className={`w-8 px-1 py-0 border rounded text-right text-[12px] font-bold outline-none focus:border-lime-400 ${(c.prepaid_banchan || 0) > 0 ? 'text-lime-700 border-lime-300' : 'border-stone-200'}`} />
            회
          </label>

          <label className="flex items-center gap-0.5 text-stone-500" title="엄마·아빠 이름으로 입금하실 때 — 입금 대조가 이 이름으로도 찾는다">
            보호자
            <input key={`p${c.id}:${(c.payer_names || []).join(',')}`} defaultValue={(c.payer_names || []).join(', ')} placeholder="입금자 이름" disabled={busy}
              onBlur={e => savePayersInline(c, e.target.value, e.target)} onKeyDown={enter}
              className="w-24 px-1 py-0 border border-stone-200 rounded text-[12px] outline-none focus:border-amber-400" />
          </label>

          <span className="text-[10px] text-stone-400 whitespace-nowrap">
            {c.last_order === undefined ? '' : c.last_order ? `최근 ${Number(c.last_order.slice(5, 7))}/${Number(c.last_order.slice(8, 10))}` : '주문 없음'}
          </span>
          <button onClick={() => setOpenLedger(openLedger === c.id ? null : c.id)}
            className="ml-auto px-2 py-0.5 border border-stone-200 text-stone-600 rounded text-[11px] font-bold hover:bg-stone-50">
            {openLedger === c.id ? '닫기' : '기록'}
          </button>
        </div>

        {/* 카톡 메모에 용량이 다른 묶음이 따로 있으면(마지막 묶음이 위의 남은 팩) */}
        {(c.prepaid_tracks || []).length > 1 && (
          <div className="pl-1 text-[10px] text-stone-400">
            {(c.prepaid_tracks || []).slice(0, -1).map((t, i) => <span key={i} className={`mr-2 ${t.balance < 0 ? 'text-red-600' : ''}`}>{t.label || '다른 묶음'} {t.balance}팩</span>)}
          </div>
        )}
        {c.is_regular && (c.regular_schedule?.slots?.length ?? 0) > 0 && (
          <div className="pl-1 text-[10px] text-violet-600">
            정기: {(c.regular_schedule?.slots || []).map(s =>
              `${s.day} ${shortStage(s.stage || c.regular_schedule?.stage)} ${s.volume || c.regular_schedule?.volume || ''} ${s.qty}팩`).join(' · ')}
          </div>
        )}

        {openLedger === c.id && (
          <div className="pb-2">
            {/* 충전 단추는 줄에서 빼고 여기로 — 간판 할인표 금액이 같이 뜬다 */}
            <div className="mt-1.5">
              <ChargeBar size="sm" label={c.prepaid_label} disabled={chargingId === c.id} onCharge={(u, l) => charge(c.id, u as any, l)} />
            </div>
            <RegularEditor customer={c} onSaved={p => patchCustomer(c.id, p)} />
            <PrepaidLedger customerId={c.id} balance={c.prepaid_balance} split={isSplit(c)} onBalance={n => setBalance(c.id, n)} onPatch={p => patchCustomer(c.id, p)} />
          </div>
        )}
      </div>
    );
  }
}

const shortStage = (st?: string | null) => String(st || '').replace('중기1단계', '중기1').replace('중기2단계', '중기2');

// ── 정기배송 고치기 ───────────────────────────────────────────────
// 사장님: "정기배송으로 해도 중간에 변경하는 경우도 있고 … 월 중기 300 3팩 목 4팩 받다가
//          월요일 후기 230 6개 화요일 후기 230 3개 금요일 후기 230 6개 이런 식으로"
// 요일마다 단계·용량·메뉴별 팩수를 따로 맞춘다. 저장하면 아직 조리 전('접수')인 그 주 주문도 바로 바뀐다.
// 딱 한 번만 바뀌는 건 여기 말고 그 주문 카드에서 고치면 된다(일정은 그대로).
const REG_DAYS = ['월', '화', '목', '금'] as const;
type RegRow = { on: boolean; stage: string; volume: number; menus: Record<string, number> };

function RegularEditor({ customer, onSaved }: { customer: Customer; onSaved: (p: Partial<Customer>) => void }) {
  const sched: any = customer.regular_schedule || {};
  const init = () => {
    const rows: Record<string, RegRow> = {};
    for (const d of REG_DAYS) {
      const s = (sched.slots || []).find((x: any) => x.day === d);
      const menus: Record<string, number> = { 한우: 0, 닭: 0, 기타단백질: 0 };
      if (s) {
        if (Array.isArray(s.menus) && s.menus.length) s.menus.forEach((m: any) => { if (m.menu in menus) menus[m.menu] = Number(m.qty) || 0; });
        else menus.한우 = Number(s.qty) || 0;
      }
      rows[d] = {
        on: !!s && customer.is_regular,
        stage: s?.stage || sched.stage || '후기',
        volume: Number(s?.volume || sched.volume) || 230,
        menus,
      };
    }
    return rows;
  };
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Record<string, RegRow>>(init);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const set = (d: string, p: Partial<RegRow>) => setRows(r => ({ ...r, [d]: { ...r[d], ...p } }));
  const total = (r: RegRow) => MENU_TYPES.reduce((a, m) => a + (Number(r.menus[m]) || 0), 0);

  async function save(active: boolean) {
    if (!active && !confirm('정기배송을 끌까요? 아직 조리 전인 정기 주문은 자동으로 취소됩니다.')) return;
    setBusy(true); setInfo(null);
    try {
      const slots = REG_DAYS.filter(d => rows[d].on && total(rows[d]) > 0)
        .map(d => ({ day: d, stage: rows[d].stage, volume: rows[d].volume, menus: rows[d].menus }));
      const r = await fetch(`/api/customers/${customer.id}/regular`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active, slots }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || String(r.status));
      onSaved({ is_regular: d.active, regular_schedule: d.regular_schedule });
      const sy = d.sync;
      setInfo(!d.autoEnabled ? '저장했어요 (자동 주문 만들기는 아직 꺼져 있어요)'
        : sy ? `저장했어요 — 이번 주 주문 새로 ${sy.created} · 바뀜 ${sy.updated + sy.revived} · 취소 ${sy.cancelled}`
               + (sy.skipped?.length ? ` · 못 만든 것 ${sy.skipped.length}건: ${sy.skipped.map((x: any) => x.reason).join(', ')}` : '')
        : `저장은 됐는데 주문 맞추기가 안 됐어요: ${d.syncError || ''}`);
    } catch (e: any) { setInfo(`못 저장했어요: ${e.message}`); }
    setBusy(false);
  }

  return (
    <div className="mt-2 border border-violet-200 rounded-lg">
      <button onClick={() => { setOpen(!open); if (!open) setRows(init()); }}
        className="w-full flex justify-between items-center px-3 py-2 text-xs font-bold text-violet-800">
        <span>정기배송 {customer.is_regular ? '고치기' : '켜기'}</span><span>{open ? '∧' : '∨'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-1.5">
          <p className="text-[11px] text-stone-500 leading-relaxed">
            요일마다 단계·용량·팩수를 따로 넣을 수 있어요. 저장하면 조리 전인 이번 주 정기 주문도 같이 바뀝니다.
            한 번만 바뀌는 건 그 주문 카드에서 고쳐 주세요.
          </p>
          {REG_DAYS.map(d => {
            const r = rows[d];
            const vols = STAGE_OPTIONS[r.stage as keyof typeof STAGE_OPTIONS]?.map(o => o.volume) || [];
            return (
              <div key={d} className={`flex flex-wrap items-center gap-1.5 rounded px-2 py-1.5 ${r.on ? 'bg-violet-50' : 'bg-stone-50'}`}>
                <label className="flex items-center gap-1 text-xs font-bold w-10">
                  <input type="checkbox" checked={r.on} onChange={e => set(d, { on: e.target.checked })} />{d}
                </label>
                <select value={r.stage} disabled={!r.on}
                  onChange={e => { const st = e.target.value; const v = STAGE_OPTIONS[st as keyof typeof STAGE_OPTIONS]; set(d, { stage: st, volume: v?.some(o => o.volume === r.volume) ? r.volume : v?.[0]?.volume || 230 }); }}
                  className="text-xs border border-stone-300 rounded px-1 py-0.5 bg-white">
                  {STAGES.map(st => <option key={st} value={st}>{shortStage(st)}</option>)}
                </select>
                <select value={r.volume} disabled={!r.on} onChange={e => set(d, { volume: Number(e.target.value) })}
                  className="text-xs border border-stone-300 rounded px-1 py-0.5 bg-white">
                  {vols.map(v => <option key={v} value={v}>{v}g</option>)}
                </select>
                {MENU_TYPES.map(m => (
                  <label key={m} className="flex items-center gap-0.5 text-[11px] text-stone-600">
                    {menuLabel(m)}
                    <input value={r.menus[m] || ''} disabled={!r.on} inputMode="numeric"
                      onChange={e => set(d, { menus: { ...r.menus, [m]: Number(e.target.value.replace(/\D/g, '').slice(0, 2)) || 0 } })}
                      className="w-8 text-xs text-right border border-stone-300 rounded px-1 py-0.5" />
                  </label>
                ))}
                <span className={`text-[11px] font-bold ${r.on && total(r) > 0 && total(r) < 3 ? 'text-rose-600' : 'text-stone-600'}`}>{total(r)}팩</span>
              </div>
            );
          })}
          <div className="flex gap-1.5 pt-1">
            <button onClick={() => save(true)} disabled={busy}
              className="flex-1 py-1.5 text-xs font-bold text-violet-800 bg-violet-100 border border-violet-300 rounded disabled:opacity-40">
              {customer.is_regular ? '이대로 저장' : '정기배송 켜기'}
            </button>
            {customer.is_regular && (
              <button onClick={() => save(false)} disabled={busy}
                className="px-3 py-1.5 text-xs font-bold text-stone-600 bg-white border border-stone-300 rounded disabled:opacity-40">끄기</button>
            )}
          </div>
          {info && <p className="text-[11px] text-violet-700">{info}</p>}
        </div>
      )}
    </div>
  );
}

// ── 도착 안내 ─────────────────────────────────────────────────────
// 배송 후 손님에게 남기는 한마디. 손님 앱 '내 주문'에 보이고, 알림을 켠 손님에겐 푸시가 간다.
// 앱 알림을 켠 손님이 거의 없어서, 같은 문구를 카톡으로 보낼 수 있게 '복사' 단추도 둔다.
function ArrivalBox({ order, onSent }: { order: Order; onSent: (note: string, at: string) => void }) {
  const [text, setText] = useState(order.arrival_note || defaultArrivalNote(order.baby_name, (order as any).receive_method));
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const sentAt = order.arrived_at ? new Date(order.arrived_at) : null;

  async function send() {
    setBusy(true); setInfo(null);
    try {
      const r = await fetch(`/api/orders/${order.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arrive: true, arrival_note: text }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.ok) { onSent(d.arrival_note, d.arrived_at); setInfo('앱에 남겼어요'); }
      else setInfo(`못 남겼어요: ${d.error || r.status}`);
    } catch (e: any) { setInfo(`못 남겼어요: ${e?.message || '네트워크 오류'}`); }
    setBusy(false);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); setInfo('복사했어요 — 카톡에 붙여넣으세요'); }
    catch { setInfo('복사가 안 돼요 — 글을 직접 골라 복사해 주세요'); }
  }

  return (
    <div className="mt-2 border border-emerald-200 bg-emerald-50/60 rounded-lg p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-bold text-emerald-800">도착 안내</span>
        <span className="text-[10px] text-emerald-700">
          {sentAt ? `남김 ${sentAt.getMonth() + 1}/${sentAt.getDate()} ${String(sentAt.getHours()).padStart(2, '0')}:${String(sentAt.getMinutes()).padStart(2, '0')}` : '아직 안 남김'}
        </span>
      </div>
      <textarea value={text} onChange={e => setText(e.target.value)} maxLength={200} rows={2}
        className="w-full px-2 py-1 border border-emerald-200 rounded text-xs bg-white outline-none focus:border-emerald-400 resize-none" />
      <div className="flex gap-1.5 mt-1">
        <button onClick={send} disabled={busy || !text.trim()}
          className="flex-1 py-1 text-[11px] font-bold text-emerald-800 bg-emerald-100 border border-emerald-300 rounded disabled:opacity-40">
          {sentAt ? '고쳐서 다시 남기기' : '앱에 남기기'}
        </button>
        <button onClick={copy}
          className="px-3 py-1 text-[11px] font-bold text-stone-600 bg-white border border-stone-200 rounded">카톡용 복사</button>
      </div>
      {info && <p className="mt-1 text-[10px] text-emerald-700">{info}</p>}
    </div>
  );
}

// ── 선결제 기록 ───────────────────────────────────────────────────
// 충전·사용·취소환불·조리표 수정이 한 줄씩 쌓인다(baby_food_prepaid_ledger).
// 마지막 줄의 '남은 팩' 이 위의 잔여와 같아야 정상 — 다르면 빨갛게 알린다.
type LedgerRow = { created_at: string; kind: string; packs: number; balance_after: number; amount_won: number | null; memo: string | null; item?: string };

type HistOrder = { id: string; created_at: string; delivery_date: string; stage: string; volume: number; total_qty: number; total_price: number; shipping_fee?: number; status: string; order_type: string; receive_method: string | null; paid?: boolean; paid_note?: string | null; source?: string | null };

// ── 카톡 메모 붙여넣기 ─────────────────────────────────────────────
// 사장님은 플러스친구 메모장에 손님별 선결제를 이렇게 적어 오셨다:
//   8/21 중230ᆞ50입 / 8/24 50-3-6-3-6=32 / … / ㅡㅡㅡㅡ후230 (용량이 달라 따로 세는 묶음)
// 그대로 붙여넣으면 줄마다 읽어서 보여주고, 저장하면 마지막 묶음의 남은 팩이 잔여가 된다.
// 계산이 틀린 줄(빼기가 안 맞음, 앞 줄 결과와 시작이 다름)은 빨갛게 — 고쳐서 다시 붙이면 된다.
// 저장은 아래 '한번에 저장' 단추가 한다(사장님: 저장 단추가 칸마다 있어서 번거롭다) — 여기선 읽어서 보여주기만
function kakaoLast(text: string) {
  const parsed = parseKakaoPrepaid(text);
  const live = parsed.tracks.filter(t => t.rows.some(r => r.kind === '입' || r.kind === '사용'));
  return { parsed, live, last: live[live.length - 1] };
}

function KakaoMemoBox({ text, setText, savedAt }: {
  text: string; setText: (s: string) => void; savedAt: string | null;
}) {
  const [open, setOpen] = useState(!!text);
  const { parsed, live, last } = kakaoLast(text);

  return (
    <div className="border border-amber-200 rounded-lg">
      <button onClick={() => setOpen(!open)} className="w-full flex justify-between items-center px-3 py-2 text-xs font-bold text-amber-800">
        <span>카톡 메모 붙여넣기{savedAt ? <span className="ml-1 font-normal text-stone-400">마지막 저장 {fmtDateTime(savedAt)}</span> : null}</span>
        <span>{open ? '∧' : '∨'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={6}
            placeholder={'메모장 내용을 그대로 붙여넣으세요\n8/21 중230ᆞ50입\n8/24 50-3-6-3-6=32\nㅡㅡㅡㅡㅡ후230  (용량이 다른 묶음은 줄긋기로)'}
            className="w-full px-2 py-1.5 border border-stone-300 rounded text-xs font-mono outline-none focus:border-amber-400" />
          {live.length > 0 && (
            <div className="space-y-2">
              {parsed.tracks.map((t, ti) => (
                <div key={ti}>
                  <p className="text-[11px] font-bold text-stone-700">
                    {t.label || '단계 표시 없음'} · 입 {t.charged}팩 · 쓴 것 {t.used}팩 ·
                    <span className={t.balance < 0 ? 'text-red-600' : 'text-amber-700'}> 남은 {t.balance}팩{t.balance < 0 ? ' (받을 팩)' : ''}</span>
                    {t === last && <span className="ml-1 text-stone-400">← 잔여로 저장</span>}
                  </p>
                  <div className="max-h-48 overflow-auto">
                    <table className="w-full text-[11px]">
                      <tbody>
                        {t.rows.filter(r => r.kind !== '구분').map(r => (
                          <tr key={r.line} className={`border-t border-stone-50 ${r.problem ? 'bg-red-50' : ''}`}>
                            <td className="py-0.5 pr-1 whitespace-nowrap text-stone-500 w-10">{r.date || ''}</td>
                            <td className="pr-1 whitespace-nowrap">
                              {r.kind === '입' ? <span className="text-emerald-700 font-bold">+{r.packs} 입{r.label ? ` ${r.label}` : ''}</span>
                                : r.kind === '사용' ? <span>{r.before} → {r.packs}</span>
                                : <span className="text-stone-400">메모</span>}
                            </td>
                            <td className={`pr-1 text-right font-bold whitespace-nowrap ${r.after !== null && r.after < 0 ? 'text-red-600' : 'text-stone-700'}`}>{r.after ?? ''}</td>
                            <td className="text-stone-500">{r.problem ? <span className="text-red-600 font-bold">{r.problem}</span> : r.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
          {text.trim() && live.length === 0 && <p className="text-[11px] text-red-600">읽을 줄이 없어요 — '8/21 중230ᆞ50입', '8/24 50-3-6=41' 모양이어야 해요</p>}
          {parsed.problems > 0 && <p className="text-[11px] text-red-600 font-bold">계산이 안 맞는 줄 {parsed.problems}개</p>}
          <p className="text-[10px] text-stone-400 leading-relaxed">
            아래 <b>한번에 저장</b>을 누르면 이 내용으로 잔여를 다시 맞춥니다(더하지 않아요){last ? ` → 잔여 ${last.balance}팩` : ''}.
            메모장에 줄을 더 적은 뒤 통째로 다시 붙이시면 됩니다.
          </p>
        </div>
      )}
    </div>
  );
}

// 선결제를 어떤 단계·용량으로 샀는지 고르는 칸 (할인표: 중기·후기 230/300, 완료기 230/300)
const PREPAID_LABELS = ['중기 230g', '중기 300g', '후기 230g', '후기 300g', '완료기 230g', '완료기 300g'];

function PrepaidLedger({ customerId, balance, split = false, onBalance, onPatch }: {
  customerId: string; balance: number; split?: boolean; onBalance: (n: number) => void; onPatch?: (p: Partial<Customer>) => void;
}) {
  const [label, setLabel] = useState('');
  const [banchan, setBanchan] = useState(0);
  const [bSet, setBSet] = useState('');
  const [bWhy, setBWhy] = useState('');
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [orders, setOrders] = useState<HistOrder[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [setTo, setSetTo] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [payers, setPayers] = useState('');
  const [payersSaved, setPayersSaved] = useState('');
  const [memo, setMemo] = useState<string | null>(null);
  const [kakao, setKakao] = useState<{ text: string; at: string | null } | null>(null);
  const [kakaoText, setKakaoText] = useState('');

  /* 한번에 저장 — 입금자 이름·카톡 메모·잔여 고치기·반찬 회수 중 바뀐 것만 모아서 저장한다.
     사장님: "저장 버튼이 엄마 이름, 카톡 내용 등에 각각 있는데 한 번에 저장시켜 줘"
     순서: 입금자 이름 → 카톡 메모(잔여를 메모대로 다시 맞춤) → 잔여 직접 고치기(적었으면 그 숫자가 최종) → 반찬 */
  const payersDirty = payers !== payersSaved;
  const kakaoDirty = !!kakao && kakaoText.trim() !== kakao.text.trim();
  const dirty = payersDirty || kakaoDirty || setTo.trim() !== '' || bSet.trim() !== '';

  async function saveAll() {
    const lines: string[] = [];
    const k = kakaoDirty ? kakaoLast(kakaoText) : null;
    if (payersDirty) lines.push(`입금자 이름: ${payers.trim() || '(지움)'}`);
    if (k) {
      if (!k.last) { setInfo('카톡 메모에서 읽을 줄이 없어요 — 고치거나 비워 주세요'); return; }
      lines.push(`카톡 메모대로 잔여 ${k.last.balance}팩${k.parsed.problems ? ` (계산 안 맞는 줄 ${k.parsed.problems}개 — 적힌 대로)` : ''}`);
    }
    const n = setTo.trim() === '' ? null : Number(setTo);
    if (n !== null) {
      if (!Number.isInteger(n) || n < 0) { setInfo('잔여는 0 이상 숫자로 적어주세요'); return; }
      lines.push(`잔여 ${balance}팩 → ${n}팩${why ? ` (${why})` : ''}`);
    }
    const bn = bSet.trim() === '' ? null : Number(bSet);
    if (bn !== null) {
      if (!Number.isInteger(bn) || bn < 0) { setInfo('반찬 회수는 0 이상 숫자로 적어주세요'); return; }
      lines.push(`반찬 ${banchan}회 → ${bn}회${bWhy ? ` (${bWhy})` : ''}`);
    }
    if (!lines.length) { setInfo('바뀐 게 없어요'); return; }
    if (!confirm('이대로 저장할까요?\n\n' + lines.join('\n'))) return;

    setBusy(true); setInfo(null);
    const done: string[] = [], fail: string[] = [];
    const post = (body: any) => fetch(`/api/customers/${customerId}/prepaid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e?.message || '네트워크 오류' }));
    try {
      if (payersDirty) {
        const list = payers.split(/[,\s·]+/).map(s => s.trim()).filter(Boolean);
        const r = await fetch('/api/customers', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: customerId, payer_names: list }),
        }).then(r => r.json()).catch(() => ({}));
        if (r.ok) { const v = (r.payer_names || []).join(', '); setPayers(v); setPayersSaved(v); done.push('입금자 이름'); }
        else fail.push(`입금자 이름(${r.error || '실패'})`);
      }
      if (k) {
        const d = await post({ memo: kakaoText });
        if (d.ok) { onBalance(d.new_balance); setLabel(d.label || ''); onPatch?.({ prepaid_label: d.label, prepaid_tracks: d.tracks, prepaid_split: null }); done.push(`카톡 메모(잔여 ${d.new_balance}팩)`); }
        else fail.push(`카톡 메모(${d.error || '실패'})`);
      }
      if (n !== null) {
        const d = await post({ set: n, memo: why });
        if (d.ok) { onBalance(d.new_balance); setSetTo(''); setWhy(''); done.push(`잔여 ${d.new_balance}팩`); }
        else fail.push(`잔여(${d.error || '실패'})`);
      }
      if (bn !== null) {
        const d = await post({ item: '반찬', set: bn, memo: bWhy });
        if (d.ok) { setBanchan(d.new_balance); onPatch?.({ prepaid_banchan: d.new_balance }); setBSet(''); setBWhy(''); done.push(`반찬 ${d.new_balance}회`); }
        else fail.push(`반찬(${d.error || '실패'})`);
      }
    } finally {
      setBusy(false);
      setInfo((done.length ? `저장했어요 — ${done.join(' · ')}` : '') + (fail.length ? ` 못 저장: ${fail.join(' · ')}` : ''));
      setReload(x => x + 1);
    }
  }

  useEffect(() => {
    let alive = true;
    fetch(`/api/customers/${customerId}/prepaid`).then(r => r.json())
      .then(d => {
        if (!alive) return;
        if (d.ok) {
          setRows(d.rows); setOrders(d.orders || []); setErr(null); setMemo(d.memo || null);
          setLabel(d.label || ''); setBanchan(Number(d.banchan) || 0);
          setKakao({ text: d.kakao_memo || '', at: d.kakao_memo_at || null }); setKakaoText(d.kakao_memo || '');
          const v = (d.payer_names || []).join(', '); setPayers(v); setPayersSaved(v);
        }
        else setErr(d.error || '불러오지 못했어요');
      })
      .catch(e => { if (alive) setErr(e?.message || '불러오지 못했어요'); });
    return () => { alive = false; };
  }, [customerId, reload]);

  async function saveLabel(v: string) {
    setLabel(v);
    const d = await fetch(`/api/customers/${customerId}/prepaid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: v }),
    }).then(r => r.json()).catch(() => ({}));
    if (d.ok) { onPatch?.({ prepaid_label: d.label }); setInfo(v ? `${v} 로 표시해요` : '단계 표시를 지웠어요'); }
    else setInfo(`못 저장했어요: ${d.error || ''}`);
  }

  // 반찬 선결제 — 팩이 아니라 '회'(세트 한 번). 4회 = 130,000원
  async function banchanApply(body: any, ask: string) {
    if (!confirm(ask)) return;
    setBusy(true); setInfo(null);
    try {
      const r = await fetch(`/api/customers/${customerId}/prepaid`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: '반찬', ...body }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.ok) { setBanchan(d.new_balance); onPatch?.({ prepaid_banchan: d.new_balance }); setBSet(''); setBWhy(''); setInfo(`반찬 ${d.new_balance}회 남았어요`); setReload(x => x + 1); }
      else setInfo(`못 고쳤어요: ${d.error || r.status}`);
    } catch (e: any) { setInfo(`못 고쳤어요: ${e?.message || '네트워크 오류'}`); }
    setBusy(false);
  }

  const fmt = (s: string) => {
    const d = new Date(s);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  // 이유식(팩)과 반찬(회)은 잔액이 따로라 마지막 줄도 따로 본다
  const lastPack = rows?.find(r => (r.item || '이유식') === '이유식');
  const lastBanchan = rows?.find(r => r.item === '반찬');
  const mismatch = (!!lastPack && lastPack.balance_after !== balance) || (!!lastBanchan && lastBanchan.balance_after !== banchan);
  const live = orders.filter(o => o.status !== '취소');

  return (
    <div className="mt-3 border-t border-stone-100 pt-2 space-y-3">
      {/* 입금자 이름 — 아기 이름 대신 엄마·아빠 이름으로 보내는 분이 많다. 입금 대조가 이 이름으로도 찾는다 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs font-bold text-stone-600">입금자 이름</span>
        <input value={payers} onChange={e => setPayers(e.target.value)} placeholder="엄마·아빠 이름 (쉼표로 여러 개)"
          className={`flex-1 min-w-[160px] px-2 py-1 border rounded text-xs outline-none focus:border-amber-400 ${payersDirty ? 'border-amber-400 bg-amber-50' : 'border-stone-300'}`} />
      </div>
      {memo && <p className="text-[11px] text-stone-500 bg-stone-50 rounded px-2 py-1 leading-relaxed">{memo}</p>}

      {/* 잔여 직접 고치기 — 여러 단계 선결제 손님은 묶음마다 위 줄 칸에서 */}
      {split ? (
        <p className="text-[11px] text-stone-500">여러 단계 선결제 손님이에요 — 묶음별 남은 팩은 위 줄의 칸(중후230·완230 …)에서 고치세요. 카톡 메모를 붙여 저장하면 한 묶음으로 다시 맞춰집니다.</p>
      ) : (
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs font-bold text-stone-600">잔여 고치기</span>
        <input value={setTo} onChange={e => setSetTo(e.target.value.replace(/\D/g, '').slice(0, 3))}
          onKeyDown={e => { if (e.key === 'Enter') saveAll(); }}
          inputMode="numeric" placeholder={String(balance)}
          className="w-14 px-2 py-1 border border-stone-300 rounded text-xs text-right outline-none focus:border-amber-400" />
        <span className="text-xs text-stone-500">팩</span>
        <input value={why} onChange={e => setWhy(e.target.value)} maxLength={100} placeholder="사유 (예: 카톡 선결제 옮김)"
          className="flex-1 min-w-[120px] px-2 py-1 border border-stone-300 rounded text-xs outline-none focus:border-amber-400" />
      </div>
      )}
      {/* 카톡 메모장 정리를 그대로 붙여넣기 — 메모장이 원본 */}
      {kakao && (
        <KakaoMemoBox key={kakao.at || 'new'} text={kakaoText} setText={setKakaoText} savedAt={kakao.at} />
      )}

      {/* 어떤 단계·용량으로 산 선결제인지 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs font-bold text-stone-600">이유식 선결제 단계</span>
        <select value={label} onChange={e => saveLabel(e.target.value)}
          className="text-xs border border-stone-300 rounded px-1.5 py-1 bg-white">
          <option value="">표시 안 함</option>
          {[...new Set([...PREPAID_LABELS, ...(label ? [label] : [])])].map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>

      {/* 반찬 선결제 — 회수로 센다 */}
      <div className="flex items-center gap-1.5 flex-wrap bg-lime-50/60 rounded px-2 py-1.5">
        <span className="text-xs font-bold text-lime-800">반찬 선결제 {banchan}회 남음</span>
        <button onClick={() => banchanApply({ times: 4, amount_won: 130000 }, '반찬 4회(130,000원)를 넣을까요?')} disabled={busy}
          className="px-2 py-0.5 border border-lime-300 text-lime-800 rounded text-[11px] font-bold disabled:opacity-40">+4회</button>
        <input value={bSet} onChange={e => setBSet(e.target.value.replace(/\D/g, '').slice(0, 2))}
          inputMode="numeric" placeholder={String(banchan)}
          className="w-10 px-1.5 py-0.5 border border-stone-300 rounded text-xs text-right outline-none focus:border-lime-400" />
        <span className="text-xs text-stone-500">회로</span>
        <input value={bWhy} onChange={e => setBWhy(e.target.value)} maxLength={100} placeholder="사유 (예: 11/11 주문 차감)"
          className="flex-1 min-w-[110px] px-2 py-0.5 border border-stone-300 rounded text-xs outline-none focus:border-lime-400" />
      </div>

      {/* 위 칸들을 한 번에 저장 — 바뀐 것만 보낸다 */}
      <button onClick={saveAll} disabled={busy || !dirty}
        className="w-full py-2 border border-amber-400 bg-amber-100 text-amber-900 rounded-lg text-sm font-black disabled:opacity-40">
        {busy ? '저장 중…' : dirty ? '한번에 저장' : '바뀐 게 없어요'}
      </button>
      {info && <p className="text-[11px] text-amber-700">{info}</p>}

      {err && <p className="text-xs text-red-600">기록을 불러오지 못했어요: {err}</p>}
      {!err && !rows && <p className="text-xs text-stone-400">기록 불러오는 중…</p>}

      {rows && (
        <div>
          <p className="text-xs font-bold text-stone-600 mb-1">선결제 기록</p>
          {mismatch && (
            <p className="mb-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
              기록상 남은 수({lastPack ? `${lastPack.balance_after}팩` : ''}{lastBanchan ? ` 반찬 ${lastBanchan.balance_after}회` : ''})와 잔여({balance}팩 · 반찬 {banchan}회)가 달라요 — 확인이 필요해요
            </p>
          )}
          {rows.length === 0 ? <p className="text-xs text-stone-400">아직 기록이 없어요</p> : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-stone-400">
                  <th className="text-left font-normal py-1">날짜</th>
                  <th className="text-left font-normal">구분</th>
                  <th className="text-right font-normal">팩</th>
                  <th className="text-right font-normal">남은 팩</th>
                  <th className="text-left font-normal pl-3">내용</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-stone-50">
                    <td className="py-1 text-stone-500 whitespace-nowrap">{fmt(r.created_at)}</td>
                    <td className="text-stone-700 whitespace-nowrap">{r.item === '반찬' ? <span className="text-lime-700">반찬 </span> : null}{r.kind}</td>
                    <td className={`text-right font-bold ${r.packs > 0 ? 'text-emerald-700' : 'text-stone-700'}`}>{r.packs > 0 ? `+${r.packs}` : r.packs}{r.item === '반찬' ? '회' : ''}</td>
                    <td className="text-right text-stone-700">{r.balance_after}{r.item === '반찬' ? '회' : ''}</td>
                    <td className="pl-3 text-stone-500">{r.memo}{r.amount_won ? ` · ${r.amount_won.toLocaleString()}원` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {rows.length >= 100 && <p className="mt-1 text-[11px] text-stone-400">최근 100줄만 보여드려요</p>}
        </div>
      )}

      {rows && (
        <div>
          <p className="text-xs font-bold text-stone-600 mb-1">
            주문 내역 {live.length}건{orders.length > live.length ? ` (취소 ${orders.length - live.length}건 별도)` : ''}
          </p>
          {orders.length === 0 ? <p className="text-xs text-stone-400">주문이 없어요</p> : (
            <div className="max-h-64 overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-stone-400">
                    <th className="text-left font-normal py-1">조리일</th>
                    <th className="text-left font-normal">구성</th>
                    <th className="text-right font-normal">팩</th>
                    <th className="text-left font-normal pl-3">구분</th>
                    <th className="text-right font-normal">금액</th>
                    <th className="text-left font-normal pl-2">입금</th>
                    <th className="text-left font-normal">주문한 날</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map(o => (
                    <tr key={o.id} className={`border-t border-stone-50 ${o.status === '취소' ? 'text-stone-300 line-through' : 'text-stone-700'}`}>
                      <td className="py-1 whitespace-nowrap font-bold">{o.delivery_date.slice(5).replace('-', '/')}</td>
                      <td className="whitespace-nowrap">{o.stage?.replace('단계', '')}{o.volume ? ` ${o.volume}` : ''}</td>
                      <td className="text-right">{o.total_qty}</td>
                      <td className="pl-3 whitespace-nowrap">{o.order_type}{o.receive_method === '픽업' ? '·픽' : ''}</td>
                      <td className="text-right whitespace-nowrap">{((o.total_price || 0) + (o.shipping_fee || 0)).toLocaleString()}</td>
                      <td className="pl-2 whitespace-nowrap" title={o.paid_note || ''}>
                        {o.order_type === '선결제' ? <span className="text-stone-400">선결제</span>
                          : o.paid ? <span className="text-emerald-700">확인</span>
                          : o.paid_note ? <span className="text-stone-400">대조안함</span>
                          : <span className="text-rose-600">미입금</span>}
                      </td>
                      <td className="whitespace-nowrap text-stone-400">{o.source ? '엑셀' : fmt(o.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
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
  /* ⚠️ 전에는 조회가 실패해도 빈 배열 그대로 두고 넘어가서, 화면에는
        "아직 등록된 후기가 없어요" 로 보였다. 장애를 '없음' 으로 착각하게 된다.
        실패는 실패라고 적고 다시 받을 수 있게 한다. */
  const [failed, setFailed] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const d = await fetch('/api/reviews?all=1').then(r => r.json());
      if (d.ok) { setReviews(d.reviews || []); setFailed(false); }
      else setFailed(true);
    } catch { setFailed(true); }
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

  // 못 불러온 것과 하나도 없는 것은 다른 상태다 — 섞어서 보여주면 안 된다
  if (failed) return (
    <div className="space-y-3">
      <AskForReviews />
      <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-5 text-center">
        <div className="text-sm font-bold text-rose-700 mb-1">후기를 불러오지 못했어요</div>
        <div className="text-[12px] text-rose-600 mb-3">등록된 후기가 없는 것과는 다릅니다 — 잠시 후 다시 눌러주세요.</div>
        <button onClick={load} className="rounded-lg border border-rose-300 bg-white px-4 py-1.5 text-sm font-bold text-rose-700">
          다시 불러오기
        </button>
      </div>
    </div>
  );

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
