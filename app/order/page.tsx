'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  STAGES, STAGE_OPTIONS, MENU_TYPES, MIN_ORDER_QTY, getPrice,
  type StageType, type MenuType
} from '@/lib/supabase';
import { weekDateOptions, weekMonday, deliveryDateOptions, formatPhone } from '@/lib/dates';

// ── 타입 ─────────────────────────────────────────────────────────
type AppMode = 'home' | 'menu' | 'order';
type MenuSel = Record<MenuType, number>;
type OrderSet = {
  id: string;
  stage: StageType | null;
  volume: number | null;
  menus: MenuSel;
  _simpleQty?: number; // 간단주문: 팩수만 저장, 메뉴 미선택
};
type DateOrder = {
  id: string;
  delivery_date: string;
  sets: OrderSet[];
};
type WeeklyMenu = { menu_type: MenuType; vegetables: string };
type Step = 1 | 2 | 3 | 4 | 5;

// ── 로컬 저장 ─────────────────────────────────────────────────────
const SAVED_KEY = 'bfo_saved_info';
type SavedInfo = {
  babyName: string; months: string; phone: string;
  address: string; addressDetail: string; doorPw: string;
  lastStage?: StageType; lastVolume?: number; // 간단주문 기본값
};

function loadSaved(): SavedInfo | null {
  try { const s = localStorage.getItem(SAVED_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
function doSave(info: SavedInfo) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(info)); } catch {}
}

// ── 헬퍼 ────────────────────────────────────────────────────────
let _uid = 0;
function uid() { return String(++_uid); }
function emptyMenus(): MenuSel { return { 한우: 0, 닭: 0, 기타단백질: 0 }; }
function newSet(): OrderSet { return { id: uid(), stage: null, volume: null, menus: emptyMenus() }; }
function newDate(): DateOrder { return { id: uid(), delivery_date: '', sets: [newSet()] }; }

function setQty(s: OrderSet, menu: MenuType, val: number): OrderSet {
  return { ...s, menus: { ...s.menus, [menu]: Math.max(0, Math.min(10, val)) } };
}
function setQtyTotal(s: OrderSet): number {
  return s._simpleQty ?? Object.values(s.menus).reduce((a, b) => a + b, 0);
}
function dateQty(d: DateOrder): number {
  return d.sets.reduce((sum, s) => sum + setQtyTotal(s), 0);
}
function datePrice(d: DateOrder): number {
  return d.sets.reduce((sum, s) => {
    if (!s.stage || !s.volume) return sum;
    return sum + getPrice(s.stage, s.volume) * setQtyTotal(s);
  }, 0);
}

// ─────────────────────────────────────────────────────────────────
// ── 메뉴보기 전용 타입 ────────────────────────────────────────────
type DayMenu = {
  date: string;
  label: string;
  dow: number;
  menus: { name: string; type: string; ingredients: string }[];
};

export default function OrderPage() {
  const [mode, setMode] = useState<AppMode>('home');
  const [step, setStep] = useState<Step>(1);
  const [savedInfo, setSavedInfo] = useState<SavedInfo | null>(null);

  // Step 1
  const [babyName, setBabyName] = useState('');
  const [months, setMonths] = useState('');

  // Step 2
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [addressDetail, setAddressDetail] = useState('');
  const [doorPw, setDoorPw] = useState('');

  // Step 3 — 복합 주문
  const [combinedDelivery, setCombinedDelivery] = useState(false); // 합배송 모드
  const [dateOrders, setDateOrders] = useState<DateOrder[]>([newDate()]);

  // 아코디언 상태
  const [openSetId, setOpenSetId] = useState<Record<string, string | null>>({});
  const [openDateId, setOpenDateId] = useState<string | null>(null); // 날짜 아코디언

  // 간단주문 상태
  type SimpleItem = { delivery_date: string; stage: StageType | null; volume: number | null; qty: number };
  const [simpleMode, setSimpleMode] = useState(false);
  const [simpleItems, setSimpleItems] = useState<SimpleItem[]>([]);
  const [weeklyMenus, setWeeklyMenus] = useState<WeeklyMenu[]>([]);
  const [dayMenus, setDayMenus] = useState<DayMenu[]>([]); // 메뉴보기용 일별 메뉴
  const [weekOffset, setWeekOffset] = useState(0);

  // ── 메뉴보기 전용 상태 ───────────────────────────────────────────
  const [menuStage, setMenuStage] = useState<StageType | null>(null);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  type MenuSel2 = { volume: number | null; qtys: Record<MenuType, number> };
  const [menuSels, setMenuSels] = useState<Record<string, MenuSel2>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [completedId, setCompletedId] = useState<string | null>(null);

  const dateOpts = useMemo(() => weekDateOptions(weekOffset), [weekOffset]);
  const currentWeekStart = useMemo(() => weekMonday(weekOffset), [weekOffset]);

  useEffect(() => {
    // 주차별 메뉴 fetch (요약 + 일별 스케줄)
    fetch(`/api/menus/current?week=${currentWeekStart}`)
      .then(r => r.json())
      .then(d => {
        if (d.menus) setWeeklyMenus(d.menus);
      }).catch(() => {});

    // 메뉴보기용 kkakung_history 일별 스케줄 fetch
    const SB_URL = 'https://ymghmfkqctckxxysxkvy.supabase.co';
    const KEY = 'sb_publishable_3-9zobXqx6Nv36LzmNMBpA_fohZqA5x';
    fetch(`${SB_URL}/rest/v1/kkakung_history?id=eq.${currentWeekStart}&select=id,yusik`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
    }).then(r => r.json()).then(rows => {
      if (!rows?.[0]?.yusik?.schedule) { setDayMenus([]); return; }
      const schedule: any[] = rows[0].yusik.schedule;
      const TYPE_KOR: Record<string, string> = { hanwoo:'한우', chicken:'닭', p3:'기타단백질' };
      const opts = weekDateOptions(weekOffset);
      const days: DayMenu[] = opts.filter(o => !o.past).map(opt => {
        const dayData = schedule.find((s:any) => s.date === opt.value);
        const menus = (dayData?.menus || []).map((m:any) => ({
          name: m.name || '',
          type: TYPE_KOR[m.type] || m.type,
          ingredients: m.ingredients || ''
        }));
        return { date: opt.value, label: opt.label, dow: opt.dow, menus };
      });
      setDayMenus(days);
    }).catch(() => setDayMenus([]));
    const s = loadSaved();
    if (s?.babyName && s?.phone) {
      setBabyName(s.babyName); setMonths(s.months);
      setPhone(s.phone); setAddress(s.address);
      setAddressDetail(s.addressDetail); setDoorPw(s.doorPw);
      setSavedInfo(s);
      // 홈화면 유지 — 메뉴보기/주문하기 선택하게
    }
  }, []);

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [step, mode]);

  // ── 뒤로가기 처리 ────────────────────────────────────────────────
  // 앱 진입 시 기준 히스토리 + 상태 변경 시 push → popstate로 이전 상태 복원
  useEffect(() => {
    // 초기 상태 replace
    window.history.replaceState({ mode: 'home', step: 1 }, '');

    function onPop(e: PopStateEvent) {
      const st = e.state as { mode?: AppMode; step?: number } | null;
      if (!st) return;
      if (st.mode) setMode(st.mode as AppMode);
      if (st.step) setStep(st.step as Step);
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // mode/step 변경 시 history push
  function goMode(m: AppMode) {
    window.history.pushState({ mode: m, step: 1 }, '');
    setMode(m);
    setStep(1);
  }
  function goStep(s: Step) {
    window.history.pushState({ mode: 'order', step: s }, '');
    setStep(s);
  }

  function applySaved() {
    if (!savedInfo) return;
    setBabyName(savedInfo.babyName); setMonths(savedInfo.months);
    setPhone(savedInfo.phone); setAddress(savedInfo.address);
    setAddressDetail(savedInfo.addressDetail); setDoorPw(savedInfo.doorPw);
    setStep(3);
  }

  // ── DateOrder 변경 헬퍼 ────────────────────────────────────────
  function updDate(id: string, fn: (d: DateOrder) => DateOrder) {
    setDateOrders(prev => prev.map(d => d.id === id ? fn(d) : d));
  }
  function updSet(dateId: string, setId: string, fn: (s: OrderSet) => OrderSet) {
    updDate(dateId, d => ({ ...d, sets: d.sets.map(s => s.id === setId ? fn(s) : s) }));
  }

  // ── 완성된 세트만 필터 (stage+volume+메뉴 1개 이상) ─────────────
  function completeSets(d: DateOrder) {
    return d.sets.filter(s => s.stage && s.volume && setQtyTotal(s) > 0);
  }

  // 날짜 → 배송 그룹 (월+화=A / 목+금=B / 나머지=날짜 자체)
  function deliveryGroup(date: string): string {
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    if (dow === 1 || dow === 2) return 'A'; // 월화
    if (dow === 4 || dow === 5) return 'B'; // 목금
    return date;
  }

  // 배송 그룹별 합산 팩수
  function groupQtys(): Record<string, number> {
    const g: Record<string, number> = {};
    for (const d of dateOrders) {
      if (!d.delivery_date) continue;
      const key = deliveryGroup(d.delivery_date);
      const qty = completeSets(d).reduce((s, cs) => s + Object.values(cs.menus).reduce((a, b) => a + b, 0), 0);
      g[key] = (g[key] || 0) + qty;
    }
    return g;
  }

  // ── 검증 ──────────────────────────────────────────────────────
  function isStep3Valid(): boolean {
    if (dateOrders.some(d => !d.delivery_date)) return false;
    if (dateOrders.some(d => completeSets(d).length === 0)) return false;
    if (combinedDelivery) {
      // 합배송 모드: 그룹별 합산 >= 3
      return Object.values(groupQtys()).every(q => q >= MIN_ORDER_QTY);
    } else {
      // 기본 모드: 날짜별 >= 3
      return dateOrders.every(d => dateQty(d) >= MIN_ORDER_QTY);
    }
  }

  function qtyWarning(): string | null {
    if (combinedDelivery) {
      const gq = groupQtys();
      const short = Object.entries(gq).find(([, q]) => q < MIN_ORDER_QTY);
      if (!short) return null;
      const label = short[0] === 'A' ? '월·화 합산' : short[0] === 'B' ? '목·금 합산' : short[0];
      return `${label} ${short[1]}팩 — 최소 ${MIN_ORDER_QTY}팩 이상이어야 해요`;
    } else {
      const short = dateOrders.find(d => completeSets(d).length > 0 && dateQty(d) < MIN_ORDER_QTY);
      if (!short) return null;
      return `${short.delivery_date || '선택한 날짜'} ${dateQty(short)}팩 — 날짜별 최소 ${MIN_ORDER_QTY}팩 이상이어야 해요`;
    }
  }

  // ── 제출 ──────────────────────────────────────────────────────
  async function submit() {
    setSubmitting(true);
    setServerError(null);

    const totalQty = dateOrders.reduce((sum, d) => sum + dateQty(d), 0);
    const totalPrice = dateOrders.reduce((sum, d) => sum + datePrice(d), 0);
    const firstDate = dateOrders[0].delivery_date;

    const itemsPayload = dateOrders.map(d => ({
      delivery_date: d.delivery_date,
      sets: d.sets.filter(s => s.stage && s.volume && setQtyTotal(s) > 0).map(s => ({
        stage: s.stage, volume: s.volume,
        price_per: getPrice(s.stage!, s.volume!),
        simple: !!s._simpleQty,
        menus: s._simpleQty ? [] : MENU_TYPES.filter(m => s.menus[m] > 0).map(m => ({ menu: m, qty: s.menus[m] })),
        qty: setQtyTotal(s),
        subtotal: getPrice(s.stage!, s.volume!) * setQtyTotal(s)
      })),
      date_qty: dateQty(d),
      date_price: datePrice(d)
    }));

    try {
      const r = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baby_name: babyName.trim(), months: parseInt(months),
          customer_phone: phone.replace(/[^\d]/g, ''),
          address: address.trim(), address_detail: addressDetail.trim(), door_password: doorPw.trim(),
          stage: dateOrders.length === 1 && dateOrders[0].sets.length === 1 ? dateOrders[0].sets[0].stage : 'mixed',
          volume: dateOrders.length === 1 && dateOrders[0].sets.length === 1 ? dateOrders[0].sets[0].volume : null,
          items: itemsPayload,
          total_qty: totalQty, total_price: totalPrice,
          delivery_date: firstDate, order_type: '일반'
        })
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '저장 실패');
      const firstSet = dateOrders[0]?.sets[0];
      doSave({
        babyName: babyName.trim(), months, phone: phone.replace(/[^\d]/g,''),
        address: address.trim(), addressDetail: addressDetail.trim(), doorPw: doorPw.trim(),
        lastStage: firstSet?.stage ?? undefined,
        lastVolume: firstSet?.volume ?? undefined
      });
      setCompletedId(d.id);
      setStep(5);
    } catch (e: any) { setServerError(e.message); }
    finally { setSubmitting(false); }
  }

  // ── 홈 화면 ─────────────────────────────────────────────────────
  if (mode === 'home') {
    return (
      <Wrap>
        <div className="text-center mb-8 pt-4">
          <div className="text-3xl mb-2">🍱</div>
          <div className="text-xl font-bold text-stone-900 mb-1">까꿍 디미방</div>
          <div className="text-sm text-stone-500">신선한 이유식을 집까지</div>
        </div>
        <div className="flex flex-col gap-3">
          <button
            onClick={() => goMode('menu')}
            className="w-full py-5 bg-white border-2 border-amber-200 rounded-2xl text-stone-900 font-bold text-base shadow-sm hover:border-amber-400 transition"
          >
            <div className="text-2xl mb-1">📋</div>
            이번 주 메뉴 보기
            <div className="text-xs text-stone-400 font-normal mt-0.5">요일별 메뉴 확인 · 바로 주문</div>
          </button>
          <button
            onClick={() => goMode('order')}
            className="w-full py-5 bg-amber-500 rounded-2xl text-white font-bold text-base shadow-sm active:bg-amber-600 transition"
          >
            <div className="text-2xl mb-1">✏️</div>
            주문하기
            <div className="text-xs text-amber-100 font-normal mt-0.5">날짜·단계·메뉴 직접 선택</div>
          </button>
        </div>
      </Wrap>
    );
  }

  // ── 메뉴보기 화면 ─────────────────────────────────────────────
  if (mode === 'menu') {
    const volOpts = menuStage ? STAGE_OPTIONS[menuStage] : [];
    const totalMenuQty = Object.values(menuSels).reduce((s, sel) =>
      s + Object.values(sel.qtys).reduce((a, b) => a + b, 0), 0);
    const totalMenuPrice = Object.values(menuSels).reduce((s, sel) => {
      if (!sel.volume || !menuStage) return s;
      const p = getPrice(menuStage, sel.volume);
      return s + p * Object.values(sel.qtys).reduce((a, b) => a + b, 0);
    }, 0);

    function setMenuQty(date: string, menu: MenuType, v: number) {
      setMenuSels(prev => ({
        ...prev,
        [date]: { ...prev[date], qtys: { ...(prev[date]?.qtys ?? emptyMenus()), [menu]: Math.max(0, Math.min(10, v)) } }
      }));
    }
    function setMenuVol(date: string, vol: number) {
      setMenuSels(prev => ({
        ...prev,
        [date]: { volume: vol, qtys: prev[date]?.qtys ?? emptyMenus() }
      }));
    }

    function goOrderFromMenu() {
      const orders: DateOrder[] = Object.entries(menuSels)
        .filter(([, sel]) => sel.volume && Object.values(sel.qtys).some(q => q > 0))
        .map(([date, sel]) => ({
          id: uid(),
          delivery_date: date,
          sets: [{ id: uid(), stage: menuStage!, volume: sel.volume!, menus: sel.qtys }]
        }));
      if (orders.length === 0) return;
      setDateOrders(orders);
      setMode('order');
      goStep(savedInfo ? 4 : 1); // 정보 있으면 바로 확인으로
    }

    return (
      <Wrap>
        {/* 헤더 */}
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => goMode('home')} className="text-stone-400 text-lg">←</button>
          <h1 className="text-lg font-bold text-stone-900 flex-1">메뉴 보기 · 주문</h1>
          <div className="flex gap-1">
            {[0,1].map(w => (
              <button key={w} onClick={() => { setWeekOffset(w); setExpandedDate(null); setMenuSels({}); }}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition ${weekOffset===w?'bg-amber-500 border-amber-500 text-white':'bg-white border-stone-200 text-stone-500'}`}>
                {w===0?'이번주':'다음주'}
              </button>
            ))}
          </div>
        </div>

        {/* 단계 선택 */}
        <div className="mb-4 bg-white rounded-xl border border-amber-100 p-3">
          <div className="text-xs text-stone-500 mb-2">아기 단계 선택</div>
          <div className="grid grid-cols-4 gap-1.5">
            {STAGES.map(st => (
              <button key={st} onClick={() => { setMenuStage(st); setMenuSels({}); setExpandedDate(null); }}
                className={`py-2 rounded-lg text-xs font-bold border transition ${menuStage===st?'bg-amber-500 border-amber-500 text-white':'bg-white border-amber-100 text-stone-700'}`}>
                {st.replace('단계','').replace('기1','기1').replace('기2','기2')}
              </button>
            ))}
          </div>
        </div>

        {!menuStage ? (
          <div className="text-center py-10 text-stone-400 text-sm">단계를 먼저 선택해주세요</div>
        ) : dayMenus.length === 0 ? (
          <div className="text-center py-10 text-stone-400 text-sm">이번 주 메뉴가 아직 등록되지 않았어요</div>
        ) : (
          <div className="space-y-2">
            {dayMenus.map(day => {
              const isOpen = expandedDate === day.date;
              const sel = menuSels[day.date];
              const dayQty = sel ? Object.values(sel.qtys).reduce((a,b)=>a+b,0) : 0;
              const dayPrice = sel?.volume ? getPrice(menuStage, sel.volume) * dayQty : 0;
              return (
                <div key={day.date} className="bg-white rounded-xl border border-amber-100 overflow-hidden">
                  {/* 날짜 헤더 — 클릭으로 열기/닫기 */}
                  <button
                    className="w-full flex items-center justify-between px-4 py-3 text-left"
                    onClick={() => setExpandedDate(isOpen ? null : day.date)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-stone-900 text-sm">{day.label}</span>
                      {dayQty > 0 && (
                        <span className="text-xs bg-amber-500 text-white px-2 py-0.5 rounded-full font-bold">
                          {dayQty}팩 · {dayPrice.toLocaleString()}원
                        </span>
                      )}
                    </div>
                    <span className="text-stone-400 text-lg">{isOpen ? '∧' : '∨'}</span>
                  </button>

                  {/* 펼쳐진 내용 */}
                  {isOpen && (
                    <div className="px-4 pb-4 border-t border-amber-50 pt-3 space-y-3">
                      {/* 용량 선택 */}
                      <div className="flex gap-2">
                        {volOpts.map(opt => (
                          <button key={opt.volume}
                            onClick={() => setMenuVol(day.date, opt.volume)}
                            className={`flex-1 py-2 rounded-xl border text-xs font-bold transition ${sel?.volume===opt.volume?'bg-stone-800 border-stone-800 text-white':'bg-white border-amber-100 text-stone-700'}`}>
                            {opt.volume}g<br/>
                            <span className="font-normal">{opt.price.toLocaleString()}원</span>
                          </button>
                        ))}
                      </div>

                      {/* 메뉴별 수량 */}
                      {sel?.volume && day.menus.map((m, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={`flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                                m.type==='한우'?'bg-amber-100 text-amber-800':m.type==='닭'?'bg-emerald-100 text-emerald-800':'bg-violet-100 text-violet-800'}`}>
                                {m.type}
                              </span>
                              <span className="text-sm font-medium text-stone-900 truncate">{m.name}</span>
                            </div>
                            <div className="text-[10px] text-stone-400 mt-0.5 pl-0.5 truncate">{m.ingredients}</div>
                          </div>
                          <QtyCtrl
                            value={sel.qtys[m.type as MenuType] ?? 0}
                            onChange={v => setMenuQty(day.date, m.type as MenuType, v)}
                          />
                        </div>
                      ))}
                      {!sel?.volume && (
                        <div className="text-xs text-stone-400">용량을 먼저 선택해주세요</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 하단 주문 버튼 */}
        {totalMenuQty > 0 && (
          <div className="fixed bottom-0 left-0 right-0 px-4 pb-6 pt-3 bg-gradient-to-t from-amber-50">
            <button onClick={goOrderFromMenu}
              className="w-full max-w-md mx-auto block py-4 bg-amber-500 text-white font-bold rounded-2xl shadow-lg text-sm">
              {totalMenuQty}팩 · {totalMenuPrice.toLocaleString()}원 — 주문하기 →
            </button>
          </div>
        )}
        <div className="h-24" />
      </Wrap>
    );
  }

  // ── 완료 화면 ─────────────────────────────────────────────────
  if (step === 5 && completedId) {
    const totalQty = dateOrders.reduce((s, d) => s + dateQty(d), 0);
    const totalPrice = dateOrders.reduce((s, d) => s + datePrice(d), 0);
    return (
      <Wrap>
        <div className="bg-white rounded-2xl p-7 shadow-sm border border-amber-100 text-center">
          <div className="text-5xl mb-4">🍱</div>
          <h1 className="text-xl font-bold text-stone-900 mb-2">주문이 접수됐어요!</h1>
          <p className="text-sm text-stone-500 mb-5 leading-relaxed">오늘 오후 12~18시에 배송됩니다</p>
          <div className="bg-amber-50 rounded-xl px-4 py-3 text-xs text-stone-700 leading-loose text-left mb-4 space-y-2">
            {dateOrders.map(d => (
              <div key={d.id}>
                <div className="font-bold text-amber-700">{d.delivery_date} ({dateQty(d)}팩)</div>
                {d.sets.filter(s=>s.stage&&s.volume).map(s => (
                  <div key={s.id} className="pl-3">
                    {s.stage} {s.volume}g — {s._simpleQty ? `${s._simpleQty}팩` : MENU_TYPES.filter(m=>s.menus[m]>0).map(m=>`${m} ${s.menus[m]}`).join(' / ')}
                  </div>
                ))}
              </div>
            ))}
            <div className="border-t border-amber-200 pt-2 font-bold">
              합계 {totalQty}팩 · {totalPrice.toLocaleString()}원
            </div>
          </div>
          <p className="text-[11px] text-stone-400">주문번호 {completedId.slice(0,8)}</p>
        </div>
      </Wrap>
    );
  }

  if (mode !== 'order') return null; // 안전장치

  return (
    <Wrap>
      <header className="mb-5">
        <button onClick={() => goMode('home')} className="text-stone-400 text-sm mb-2 block">← 처음으로</button>
        <h1 className="text-2xl font-bold text-stone-900">이유식 주문</h1>
        <StepBar current={step} total={4} />
      </header>

      {/* ── Step 1 아기 정보 ─────────────────────── */}
      {step === 1 && (
        <>
          {savedInfo && (
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl p-4">
              <div className="text-xs text-amber-700 font-bold mb-1">이전 주문 정보가 있어요</div>
              <div className="text-sm text-stone-700 mb-3 leading-relaxed">
                <span className="font-bold">{savedInfo.babyName}</span> · {formatPhone(savedInfo.phone)}<br/>
                <span className="text-xs text-stone-500">{savedInfo.address}</span>
              </div>
              <button onClick={applySaved} className="w-full py-3 bg-amber-500 text-white font-bold rounded-xl text-sm mb-2">
                이 정보로 바로 주문하기 →
              </button>
              <button onClick={() => setSavedInfo(null)} className="w-full text-xs text-stone-400 py-1">새로 입력할게요</button>
            </div>
          )}
          <Section title="아기 정보를 알려주세요">
            <div className="flex gap-3 items-end mb-3">
              <label className="flex-1">
                <span className="text-xs text-stone-600 font-medium mb-1.5 block">아기 이름</span>
                <input value={babyName} onChange={e=>setBabyName(e.target.value)} maxLength={15} placeholder="예: 리안이" className={iSmCls}/>
              </label>
              <label className="w-28">
                <span className="text-xs text-stone-600 font-medium mb-1.5 block">개월수</span>
                <div className="flex items-center gap-1.5">
                  <input value={months} onChange={e=>setMonths(e.target.value.replace(/\D/g,''))} inputMode="numeric" maxLength={2} placeholder="7" className={`${iSmCls} w-14 text-center`}/>
                  <span className="text-stone-500 text-sm flex-shrink-0">개월</span>
                </div>
              </label>
            </div>
            <div className="flex justify-end mt-5">
              <button
                onClick={()=>goStep(2)}
                disabled={!babyName.trim()||!months||parseInt(months)<=0}
                className="px-10 py-4 bg-amber-500 text-white font-bold text-base rounded-2xl shadow-sm active:bg-amber-600 disabled:bg-stone-200 disabled:text-stone-400 transition"
              >
                다음 →
              </button>
            </div>
          </Section>
        </>
      )}

      {/* ── Step 2 배송 정보 ─────────────────────── */}
      {step === 2 && (
        <Section title="배송 정보를 입력해주세요">
          <Field label="연락처"><input value={phone} onChange={e=>setPhone(e.target.value)} inputMode="numeric" maxLength={13} placeholder="010-0000-0000" className={iCls}/></Field>
          <Field label="주소"><input value={address} onChange={e=>setAddress(e.target.value)} placeholder="서울시 서초구..." className={iCls}/></Field>
          <Field label="상세주소"><input value={addressDetail} onChange={e=>setAddressDetail(e.target.value)} placeholder="동·호수 등" className={iCls}/></Field>
          <Field label="현관 비밀번호 (선택)"><input value={doorPw} onChange={e=>setDoorPw(e.target.value)} placeholder="예: #1234*" className={iCls}/></Field>
          <Row2>
            <BackBtn onClick={()=>goStep(1)}/>
            <PrimaryBtn onClick={()=>goStep(3)} disabled={!phone.replace(/\D/g,'').match(/^\d{10,11}$/)||!address.trim()}>다음</PrimaryBtn>
          </Row2>
        </Section>
      )}

      {/* ── Step 3 주문 구성 ─────────────────────── */}
      {step === 3 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-bold text-stone-900">주문 구성</h2>
            {savedInfo && (
              <button onClick={() => { setSavedInfo(null); goStep(1); }}
                className="text-xs text-amber-600 underline underline-offset-2">정보 수정</button>
            )}
          </div>
          {savedInfo && (
            <div className="text-xs text-stone-500 mb-3 bg-amber-50 rounded-lg px-3 py-2">
              {savedInfo.babyName} · {savedInfo.address}
            </div>
          )}

          {/* 주문 방식 탭 */}
          <div className="flex gap-2 mb-4">
            <button onClick={() => setSimpleMode(false)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-bold border transition ${!simpleMode?'bg-amber-500 border-amber-500 text-white':'bg-white border-amber-100 text-stone-600'}`}>
              상세 주문
            </button>
            <button onClick={() => setSimpleMode(true)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-bold border transition ${simpleMode?'bg-amber-500 border-amber-500 text-white':'bg-white border-amber-100 text-stone-600'}`}>
              간단 주문
            </button>
          </div>

          {/* ── 간단 주문 ────────────────────────────── */}
          {simpleMode && (() => {
            // 이번주/다음주 탭 — past 포함해 표시, past는 비활성
            const opts = weekDateOptions(weekOffset);
            function updSimple(date: string, fn: (it: SimpleItem) => SimpleItem) {
              setSimpleItems(prev => {
                const exist = prev.find(i => i.delivery_date === date);
                if (exist) return prev.map(i => i.delivery_date === date ? fn(i) : i);
                const def: SimpleItem = { delivery_date: date, stage: savedInfo?.lastStage ?? null, volume: savedInfo?.lastVolume ?? null, qty: 0 };
                return [...prev, fn(def)];
              });
            }
            function getSimple(date: string): SimpleItem {
              return simpleItems.find(i => i.delivery_date === date) ?? { delivery_date: date, stage: savedInfo?.lastStage ?? null, volume: savedInfo?.lastVolume ?? null, qty: 0 };
            }
            const totalSimpleQty = simpleItems.reduce((s, i) => s + i.qty, 0);
            const totalSimplePrice = simpleItems.reduce((s, i) => {
              if (!i.stage || !i.volume) return s;
              return s + getPrice(i.stage, i.volume) * i.qty;
            }, 0);
            // 간단주문 유효성: 선택된 날짜별 3팩+, stage/volume 있음
            const simpleValid = simpleItems.some(i => i.qty >= MIN_ORDER_QTY && i.stage && i.volume);

            return (
              <div>
                {/* 이번주 / 다음주 탭 */}
                <div className="flex gap-2 mb-3">
                  {[0,1].map(w => (
                    <button key={w} onClick={() => setWeekOffset(w)}
                      className={`flex-1 py-2 rounded-xl text-xs font-bold border transition ${weekOffset===w?'bg-amber-500 border-amber-500 text-white':'bg-white border-amber-100 text-stone-600'}`}>
                      {w===0?'이번 주':'다음 주'}
                    </button>
                  ))}
                </div>

                <div className="space-y-2">
                  {opts.map(opt => {
                    const it = getSimple(opt.value);
                    const isActive = it.qty > 0;
                    const isPast = opt.past;
                    return (
                      <div key={opt.value} className={`bg-white rounded-xl border overflow-hidden ${isPast?'opacity-40':isActive?'border-amber-400':'border-amber-100'}`}>
                        {/* 요일 헤더 */}
                        <div className="flex items-center justify-between px-4 py-3">
                          <div>
                            <span className={`font-bold text-sm ${isActive?'text-amber-700':'text-stone-700'}`}>{opt.label}</span>
                            {isActive && <span className="ml-2 text-xs text-amber-600 font-bold">{it.stage} {it.volume}g</span>}
                          </div>
                          <QtyCtrl value={it.qty} onChange={v => { if(!isPast) updSimple(opt.value, i => ({ ...i, qty: v })); }} />
                        </div>
                        {/* 팩 > 0이면 단계·용량 선택 */}
                        {it.qty > 0 && (
                          <div className="px-4 pb-3 border-t border-amber-50 pt-2 space-y-2">
                            <div className="grid grid-cols-4 gap-1">
                              {STAGES.map(st => (
                                <button key={st} onClick={() => updSimple(opt.value, i => ({ ...i, stage: st, volume: null }))}
                                  className={`py-1.5 rounded-lg text-[11px] font-bold border ${it.stage===st?'bg-amber-500 border-amber-500 text-white':'bg-white border-amber-100 text-stone-700'}`}>
                                  {st.replace('단계','').replace('중기1','중1').replace('중기2','중2').replace('완료기','완료').replace('후기','후기')}
                                </button>
                              ))}
                            </div>
                            {it.stage && (
                              <div className="grid grid-cols-2 gap-1">
                                {STAGE_OPTIONS[it.stage].map(opt2 => (
                                  <button key={opt2.volume} onClick={() => updSimple(opt.value, i => ({ ...i, volume: opt2.volume }))}
                                    className={`py-1.5 rounded-lg text-xs border ${it.volume===opt2.volume?'bg-stone-800 border-stone-800 text-white':'bg-white border-amber-100 text-stone-700'}`}>
                                    {opt2.volume}g · {opt2.price.toLocaleString()}원
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {totalSimpleQty > 0 && (
                  <div className="mt-3 bg-stone-800 text-white rounded-xl px-4 py-3 flex justify-between text-sm font-bold">
                    <span>합계 {totalSimpleQty}팩</span>
                    <span>{totalSimplePrice.toLocaleString()}원</span>
                  </div>
                )}

                <Row2>
                  <BackBtn onClick={() => setStep(2)}/>
                  <PrimaryBtn
                    onClick={() => {
                      // 간단주문 → dateOrders 변환 (메뉴 없이 qty만)
                      const orders: DateOrder[] = simpleItems
                        .filter(i => i.qty > 0 && i.stage && i.volume)
                        .map(i => ({
                          id: uid(), delivery_date: i.delivery_date,
                          sets: [{ id: uid(), stage: i.stage!, volume: i.volume!, menus: emptyMenus() }],
                          _simpleQty: i.qty // 팩수 힌트 (submit에서 items에 반영)
                        } as any)
                      );
                      if (orders.length === 0) return;
                      // 간단주문: _simpleQty 플래그로 저장, 메뉴 빈 채로
                      setDateOrders(orders.map(o => {
                        const it = simpleItems.find(i => i.delivery_date === o.delivery_date);
                        if (!it) return o;
                        return { ...o, sets: o.sets.map(s => ({ ...s, menus: emptyMenus(), _simpleQty: it.qty })) };
                      }));
                      goStep(4);
                    }}
                    disabled={!simpleValid}
                  >주문 확인</PrimaryBtn>
                </Row2>
              </div>
            );
          })()}

          {/* ── 상세 주문 ────────────────────────────── */}
          {!simpleMode && (
            <><p className="text-xs text-stone-500 mb-4">날짜별로 다르게 · 한 날짜에 여러 단계·용량 가능</p>

          <div className="space-y-4">
            {dateOrders.map((d, di) => {
              const isDateOpen = openDateId === null ? di === 0 : openDateId === d.id;
              const dateSummary = d.delivery_date
                ? `${d.delivery_date} · ${dateQty(d) > 0 ? dateQty(d)+'팩' : '팩 미선택'}`
                : '날짜 미선택';
              return (
              <div key={d.id} className="bg-white rounded-2xl border border-amber-200 overflow-hidden">
                {/* 날짜 헤더 — 아코디언 */}
                <button
                  className={`w-full flex items-center justify-between px-4 py-3 text-left transition ${isDateOpen?'bg-amber-500':'bg-amber-50'}`}
                  onClick={() => setOpenDateId(isDateOpen ? null : d.id)}
                >
                  <span className={`font-bold text-sm ${isDateOpen?'text-white':'text-amber-800'}`}>
                    {di+1}번째 날짜
                    <span className={`ml-2 font-normal text-xs ${isDateOpen?'text-amber-100':'text-stone-500'}`}>{dateSummary}</span>
                  </span>
                  <div className="flex items-center gap-2">
                    {dateOrders.length > 1 && (
                      <span onClick={e=>{e.stopPropagation();setDateOrders(prev=>prev.filter(x=>x.id!==d.id));}}
                        className={`text-lg leading-none px-1 ${isDateOpen?'text-white opacity-70':'text-stone-400'}`}>✕</span>
                    )}
                    <span className={isDateOpen?'text-white':'text-stone-400'}>{isDateOpen?'∧':'∨'}</span>
                  </div>
                </button>

                {isDateOpen && <div className="p-4 space-y-4">
                  {/* 조리일 선택 — 주 단위 탭 */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-xs text-stone-500 font-medium">조리일 선택 (월·화·목·금)</div>
                      <div className="flex gap-1">
                        <button
                          onClick={()=>setWeekOffset(0)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition ${weekOffset===0?'bg-amber-500 border-amber-500 text-white':'bg-white border-stone-200 text-stone-500'}`}>
                          이번 주
                        </button>
                        <button
                          onClick={()=>setWeekOffset(1)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition ${weekOffset===1?'bg-amber-500 border-amber-500 text-white':'bg-white border-stone-200 text-stone-500'}`}>
                          다음 주
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {dateOpts.map(opt => (
                        <button key={opt.value}
                          onClick={()=>{ if(!opt.past) updDate(d.id, x=>({...x, delivery_date: opt.value})); }}
                          disabled={opt.past}
                          className={`py-2.5 rounded-xl border text-sm font-medium transition
                            ${d.delivery_date===opt.value ? 'bg-amber-500 border-amber-500 text-white'
                            : opt.past ? 'bg-stone-50 border-stone-100 text-stone-300 cursor-not-allowed'
                            : 'bg-white border-amber-100 text-stone-700 hover:border-amber-400'}`}>
                          {opt.label}
                          {opt.past && <span className="block text-[10px]">마감</span>}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 단계·용량·메뉴 세트 — 아코디언 */}
                  {d.sets.map((s, si) => {
                    const isSetOpen = (openSetId[d.id] ?? d.sets[0]?.id) === s.id;
                    const setQtyTotal = Object.values(s.menus).reduce((a,b)=>a+b,0);
                    const setSummary = s.stage && s.volume
                      ? `${s.stage} ${s.volume}g${setQtyTotal > 0 ? ` · ${setQtyTotal}팩` : ''}`
                      : '단계·용량 미선택';
                    return (
                      <div key={s.id} className="border border-amber-100 rounded-xl overflow-hidden bg-amber-50">
                        {/* 세트 헤더 — 탭으로 열기/닫기 */}
                        <button
                          className="w-full flex items-center justify-between px-3 py-2.5 text-left"
                          onClick={() => setOpenSetId(prev => ({
                            ...prev,
                            [d.id]: isSetOpen ? null : s.id
                          }))}
                        >
                          <span className="text-xs text-amber-700 font-bold">
                            세트 {si+1}
                            <span className="ml-2 font-normal text-stone-600">{setSummary}</span>
                          </span>
                          <div className="flex items-center gap-2">
                            {d.sets.length > 1 && (
                              <span
                                onClick={e => { e.stopPropagation(); updDate(d.id, x=>({...x, sets:x.sets.filter(ss=>ss.id!==s.id)})); }}
                                className="text-stone-300 text-sm px-1">✕</span>
                            )}
                            <span className="text-stone-400 text-sm">{isSetOpen ? '∧' : '∨'}</span>
                          </div>
                        </button>

                        {isSetOpen && (
                          <div className="px-3 pb-3 border-t border-amber-100">
                            {/* 단계 선택 */}
                            <div className="mb-2 mt-2">
                              <div className="text-[11px] text-stone-500 mb-1.5">단계</div>
                              <div className="grid grid-cols-2 gap-1.5">
                                {STAGES.map(st => (
                                  <button key={st}
                                    onClick={()=>updSet(d.id, s.id, x=>({...x, stage:st, volume:null}))}
                                    className={`py-2 rounded-lg text-xs font-bold border transition ${s.stage===st?'bg-amber-500 border-amber-500 text-white':'bg-white border-amber-100 text-stone-700'}`}>
                                    {st}
                                  </button>
                                ))}
                              </div>
                            </div>

                            {/* 용량 선택 */}
                            {s.stage && (
                              <div className="mb-2">
                                <div className="text-[11px] text-stone-500 mb-1.5">용량</div>
                                <div className="grid grid-cols-2 gap-1.5">
                                  {STAGE_OPTIONS[s.stage].map(opt => (
                                    <button key={opt.volume}
                                      onClick={()=>updSet(d.id, s.id, x=>({...x, volume:opt.volume}))}
                                      className={`py-2 rounded-lg text-xs border transition ${s.volume===opt.volume?'bg-stone-800 border-stone-800 text-white':'bg-white border-amber-100 text-stone-700'}`}>
                                      {opt.volume}g · {opt.price.toLocaleString()}원
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* 메뉴별 수량 */}
                            {s.stage && s.volume && (
                              <div>
                                <div className="text-[11px] text-stone-500 mb-1.5">메뉴별 수량</div>
                                <div className="space-y-2">
                                  {MENU_TYPES.map(menu => {
                                    const wm = weeklyMenus.find(m=>m.menu_type===menu);
                                    return (
                                      <div key={menu} className="flex items-center justify-between bg-white rounded-lg px-3 py-2">
                                        <div>
                                          <div className="text-sm font-bold text-stone-900">{menu}</div>
                                          {wm && <div className="text-[10px] text-stone-400">{wm.vegetables}</div>}
                                        </div>
                                        <QtyCtrl value={s.menus[menu]} onChange={v=>updSet(d.id, s.id, x=>setQty(x, menu, v))}/>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* + 다른 단계·용량 추가 — 추가 시 새 세트 자동 오픈 */}
                  <button onClick={() => {
                    const newS = newSet();
                    updDate(d.id, x=>({...x, sets:[...x.sets, newS]}));
                    setOpenSetId(prev => ({ ...prev, [d.id]: newS.id }));
                  }}
                    className="w-full py-2.5 border-2 border-dashed border-amber-300 text-amber-700 text-sm font-medium rounded-xl hover:bg-amber-50">
                    + 다른 단계·용량 추가
                  </button>

                  {/* 날짜 소계 */}
                  {completeSets(d).length > 0 && (
                    <div className="flex justify-between text-sm font-bold px-3 py-2 rounded-xl bg-amber-100 text-amber-800">
                      <span>{d.delivery_date || '날짜 미선택'} 소계 · {dateQty(d)}팩</span>
                      <span>{datePrice(d).toLocaleString()}원</span>
                    </div>
                  )}
                </div>}
              </div>
              );
            })}
          </div>

          {/* + 날짜 추가 — 추가 시 새 날짜 자동 오픈 */}
          <button onClick={() => {
            const nd = newDate();
            setDateOrders(prev => [...prev, nd]);
            setOpenDateId(nd.id);
          }}
            className="w-full mt-3 py-3.5 border-2 border-dashed border-amber-300 text-amber-700 font-bold rounded-2xl hover:bg-amber-50">
            + 다른 날짜 추가
          </button>

          {/* 전체 합계 + 경고 + 합배송 */}
          {dateOrders.some(d=>completeSets(d).length>0) && (
            <>
              {qtyWarning() && (
                <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                  ⚠ {qtyWarning()}
                </div>
              )}
              <div className="mt-2 bg-stone-800 text-white rounded-xl px-4 py-3 flex justify-between text-sm font-bold">
                <span>전체 {dateOrders.reduce((s,d)=>s+dateQty(d),0)}팩</span>
                <span>{dateOrders.reduce((s,d)=>s+datePrice(d),0).toLocaleString()}원</span>
              </div>
              {/* 합배송 토글 — 눈에 잘 안 띄게 작게 */}
              <button
                onClick={() => setCombinedDelivery(v => !v)}
                className={`mt-2 w-full py-2 text-xs rounded-lg border transition ${combinedDelivery ? 'bg-amber-100 border-amber-300 text-amber-800 font-bold' : 'bg-white border-stone-200 text-stone-400'}`}
              >
                {combinedDelivery ? '✓ 합배송 적용 중 (월+화 / 목+금 묶음)' : '합배송 신청 (월+화 또는 목+금 묶어서 1회 배송)'}
              </button>
            </>
          )}

          <Row2>
            <BackBtn onClick={()=>goStep(2)}/>
            <PrimaryBtn onClick={()=>goStep(4)} disabled={!isStep3Valid()}>주문 확인</PrimaryBtn>
          </Row2>
          </>)}
        </div>
      )}

      {/* ── Step 4 확인 ──────────────────────────── */}
      {step === 4 && (
        <Section title="주문 내용을 확인해주세요">
          {/* 배송 정보 + 수정 버튼 */}
          <div className="bg-white rounded-xl border border-amber-100 p-4 text-sm space-y-2 mb-4">
            <div className="flex items-center justify-between pb-1 border-b border-stone-50">
              <span className="text-stone-400">아기</span>
              <span className="text-stone-900 font-medium">{babyName} ({months}개월)</span>
            </div>
            <div className="flex items-center justify-between py-1 border-b border-stone-50">
              <span className="text-stone-400">연락처</span>
              <span className="text-stone-900 font-medium">{formatPhone(phone)}</span>
            </div>
            <div className="flex items-start justify-between py-1 border-b border-stone-50 gap-2">
              <span className="text-stone-400 flex-shrink-0">주소</span>
              <span className="text-stone-900 font-medium text-right">{address}{addressDetail?' '+addressDetail:''}</span>
            </div>
            {doorPw && <div className="flex justify-between py-1 border-b border-stone-50"><span className="text-stone-400">현관비번</span><span className="text-stone-900 font-medium">{doorPw}</span></div>}
            <button
              onClick={()=>goStep(2)}
              className="w-full mt-1 py-2 text-xs text-amber-700 border border-amber-200 rounded-lg bg-amber-50 font-medium"
            >
              주소 수정하기
            </button>
          </div>

          {/* 날짜별 주문 내역 */}
          {dateOrders.map((d, di) => (
            <div key={d.id} className="bg-white rounded-xl border border-amber-200 p-4 mb-3 text-sm">
              <div className="font-bold text-amber-700 mb-2">{di+1}번째 — {d.delivery_date} ({dateQty(d)}팩 · {datePrice(d).toLocaleString()}원)</div>
              {d.sets.filter(s=>s.stage&&s.volume).map(s => (
                <div key={s.id} className="pl-3 mb-1 text-stone-700">
                  <span className="font-medium">{s.stage} {s.volume}g</span> —{' '}
                  {s._simpleQty ? `${s._simpleQty}팩` : MENU_TYPES.filter(m=>s.menus[m]>0).map(m=>`${m} ${s.menus[m]}팩`).join(' · ')}
                </div>
              ))}
            </div>
          ))}

          {/* 같은 내용으로 다른 날짜 추가 */}
          <button
            onClick={() => {
              // 현재 dateOrders의 첫 번째(또는 전체) 세트를 복사해 날짜만 비운 새 항목 추가
              const copied: DateOrder = {
                id: uid(),
                delivery_date: '',
                sets: dateOrders[dateOrders.length - 1].sets.map(s => ({
                  ...s,
                  id: uid(),
                  menus: { ...s.menus }
                }))
              };
              setDateOrders(prev => [...prev, copied]);
              goStep(3); // 날짜 선택 화면으로
            }}
            className="w-full mb-3 py-3 border-2 border-dashed border-amber-300 text-amber-700 text-sm font-bold rounded-xl"
          >
            + 같은 내용으로 다른 날짜 추가
          </button>

          <div className="bg-stone-800 text-white rounded-xl px-4 py-3 flex justify-between text-sm font-bold mb-4">
            <span>전체 {dateOrders.reduce((s,d)=>s+dateQty(d),0)}팩</span>
            <span>{dateOrders.reduce((s,d)=>s+datePrice(d),0).toLocaleString()}원</span>
          </div>

          {serverError && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{serverError}</div>}

          <Row2>
            <BackBtn onClick={()=>goStep(3)}/>
            <PrimaryBtn onClick={submit} disabled={submitting}>{submitting?'접수 중…':'주문 완료'}</PrimaryBtn>
          </Row2>
        </Section>
      )}
    </Wrap>
  );
}

// ── 공통 컴포넌트 ─────────────────────────────────────────────────
function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="max-w-md mx-auto px-4 py-6 pb-28">{children}</div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h2 className="text-lg font-bold text-stone-900 mb-4">{title}</h2>{children}</section>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block mb-3"><span className="text-xs text-stone-600 font-medium mb-1.5 block">{label}</span>{children}</label>;
}
function SRow({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-3 py-1 border-b border-stone-50 last:border-0"><span className="text-stone-400">{k}</span><span className="text-stone-900 font-medium text-right">{v}</span></div>;
}
function StepBar({ current, total }: { current: number; total: number }) {
  return <div className="flex gap-1 mt-2">{Array.from({length:total}).map((_,i)=><div key={i} className={`h-1 flex-1 rounded-full ${i+1<=current?'bg-amber-500':'bg-amber-100'}`}/>)}</div>;
}
function PrimaryBtn({ onClick, disabled, children }: { onClick:()=>void; disabled?:boolean; children:React.ReactNode }) {
  return <button onClick={onClick} disabled={disabled} className="flex-1 py-3.5 bg-amber-500 text-white font-bold rounded-xl shadow-sm active:bg-amber-600 disabled:bg-stone-200 disabled:text-stone-400 transition">{children}</button>;
}
function BackBtn({ onClick }: { onClick:()=>void }) {
  return <button onClick={onClick} className="px-5 py-3.5 bg-white border border-amber-100 text-stone-600 font-medium rounded-xl">이전</button>;
}
function Row2({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2 mt-5">{children}</div>;
}
function QtyCtrl({ value, onChange }: { value:number; onChange:(v:number)=>void }) {
  return <div className="flex items-center gap-2">
    <button onClick={()=>onChange(value-1)} disabled={value<=0} className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 font-bold text-lg disabled:opacity-30">−</button>
    <span className="w-6 text-center font-bold text-stone-900">{value}</span>
    <button onClick={()=>onChange(value+1)} disabled={value>=10} className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 font-bold text-lg disabled:opacity-30">+</button>
  </div>;
}
const iCls = 'w-full px-3.5 py-3 bg-white border border-amber-100 rounded-xl outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100 transition text-[16px]';
const iSmCls = 'w-full px-3 py-2.5 bg-white border border-amber-100 rounded-xl outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100 transition text-[16px]';
