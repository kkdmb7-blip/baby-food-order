'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  STAGES, STAGE_OPTIONS, MENU_TYPES, MIN_ORDER_QTY, BANCHAN_PRICE, getPrice,
  type StageType, type MenuType
} from '@/lib/supabase';
import { weekDateOptions, weekMonday, deliveryDateOptions, formatPhone, allWeekDays } from '@/lib/dates';
import { ALLERGENS, COMMON_KEYS, allergenByKey, matchAllergens } from '@/lib/allergens';
import {
  recommendStage, stageGuide, stageTransitionNote,
  loadDiary, setFoodStatus, foodKeysByStatus, testingDays, type Diary, type FoodStatus,
  saveLastOrder, loadLastOrder, daysSinceLastOrder, type SavedSet,
  loadReactions, setReaction, likedMenuNames, type MenuReaction, type MenuReactions,
  SYMPTOMS, loadSymptoms, addSymptom, removeSymptom, type SymptomEntry,
  loadSeenStatus, saveSeenStatus, hasSeenStatusRecord,
} from '@/lib/personalize';
import { addPhoto, listPhotos, deletePhoto, type PhotoMeta } from '@/lib/album';

// ── 타입 ─────────────────────────────────────────────────────────
type AppMode = 'home' | 'menu' | 'order' | 'calendar' | 'mypage' | 'album';
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
  allergies?: string[]; // 알레르기 키 목록 (한 번 등록 → 유지)
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
  banchan?: { name: string; ingredients: string }[];
  soup?: { name: string; ingredients: string };
};

export default function OrderPage() {
  const [mode, setMode] = useState<AppMode>('home');
  const [step, setStep] = useState<Step>(1);
  const [savedInfo, setSavedInfo] = useState<SavedInfo | null>(null);

  // ── 알레르기 (한 번 등록 → localStorage 유지, 언제든 해제 가능) ──
  const [allergies, setAllergies] = useState<string[]>([]);
  const [allergyOpen, setAllergyOpen] = useState(false); // 등록 UI 펼침
  function toggleAllergy(key: string) {
    setAllergies(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      try { localStorage.setItem('bfo_allergies', JSON.stringify(next)); } catch {}
      return next;
    });
  }

  // ── 재료 도감(②④) / 재주문(③⑥) ──────────────────────────────
  const [diary, setDiary] = useState<Diary>({});
  const [diaryOpen, setDiaryOpen] = useState(false);
  const [lastOrder, setLastOrder] = useState(() => null as ReturnType<typeof loadLastOrder>);
  function updateFood(key: string, status: FoodStatus) {
    setDiary(setFoodStatus(key, status));
    // 알레르기로 표시하면 알레르기 목록에도 자동 추가 / 해제 시 제거
    if (status === 'allergic' && !allergies.includes(key)) toggleAllergy(key);
    if (status !== 'allergic' && allergies.includes(key) && diary[key]?.status === 'allergic') toggleAllergy(key);
  }

  // ── A. 메뉴 반응 / B. 이상반응 기록 ─────────────────────────────
  const [reactions, setReactions] = useState<MenuReactions>({});
  function rateMenu(name: string, r: MenuReaction) {
    setReactions(setReaction(name, reactions[name] === r ? null : r));
  }
  const [symptoms, setSymptoms] = useState<SymptomEntry[]>([]);
  function logSymptom(foodKey: string, symptom: string) {
    setSymptoms(addSymptom({ foodKey, symptom, date: new Date().toISOString().slice(0, 10) }));
  }
  function delSymptom(idx: number) { setSymptoms(removeSymptom(idx)); }

  // ── D+⑦. 내 주문 조회 ──────────────────────────────────────────
  const [myPhone, setMyPhone] = useState('');
  const [myName, setMyName] = useState('');
  const [myData, setMyData] = useState<{ orders: any[]; customer: any; mismatch?: boolean } | null>(null);
  const [myLoading, setMyLoading] = useState(false);
  const [myError, setMyError] = useState<string | null>(null);
  // ── 배송상태 알림 배너 ──────────────────────────────────────────
  const [statusAlerts, setStatusAlerts] = useState<{ id: string; status: string; delivery_date: string }[]>([]);
  function dismissAlerts() {
    // 현재 상태를 '본 것'으로 기록하고 배너 닫기
    const seen = loadSeenStatus();
    statusAlerts.forEach(a => { seen[a.id] = a.status; });
    saveSeenStatus(seen);
    setStatusAlerts([]);
  }

  // ── E. 성장앨범 (기기 저장) ─────────────────────────────────────
  const [photos, setPhotos] = useState<PhotoMeta[]>([]);
  const [albumBusy, setAlbumBusy] = useState(false);
  const [albumNote, setAlbumNote] = useState('');
  async function refreshAlbum() { setPhotos(await listPhotos()); }
  async function onAddPhoto(file: File | undefined) {
    if (!file) return;
    setAlbumBusy(true);
    try { await addPhoto(file, albumNote); setAlbumNote(''); await refreshAlbum(); }
    catch {} finally { setAlbumBusy(false); }
  }
  async function onDeletePhoto(id: string) { await deletePhoto(id); await refreshAlbum(); }

  async function fetchMyOrders(p: string, nm?: string) {
    const digits = p.replace(/\D/g, '');
    const nameVal = (nm ?? myName).trim();
    if (!/^\d{10,11}$/.test(digits)) { setMyError('연락처를 정확히 입력해주세요'); return; }
    if (!nameVal) { setMyError('아기 이름을 입력해주세요'); return; }
    setMyLoading(true); setMyError(null);
    try {
      const r = await fetch(`/api/my?phone=${digits}&name=${encodeURIComponent(nameVal)}`);
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '조회 실패');
      if (d.mismatch) { setMyError('연락처와 아기 이름이 일치하지 않아요'); setMyData(null); }
      else setMyData({ orders: d.orders, customer: d.customer });
    } catch (e: any) { setMyError(e.message); setMyData(null); }
    finally { setMyLoading(false); }
  }

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
  const [copyMode, setCopyMode] = useState(false); // 같은내용 날짜추가 모드

  // 간단주문 상태
  type SimpleItem = { delivery_date: string; stage: StageType | null; volume: number | null; qty: number };
  const [simpleMode, setSimpleMode] = useState(false);
  const [simpleItems, setSimpleItems] = useState<SimpleItem[]>([]);
  const [weeklyMenus, setWeeklyMenus] = useState<WeeklyMenu[]>([]);
  const [dayMenus, setDayMenus] = useState<DayMenu[]>([]); // 메뉴보기용 일별 메뉴
  const [weekOffset, setWeekOffset] = useState(0);
  const [banchanQtys, setBanchanQtys] = useState<Record<string, number>>({}); // 반찬 세트 수량

  // ── 메뉴보기 전용 상태 ───────────────────────────────────────────
  const [menuStage, setMenuStage] = useState<StageType | null>(null); // 레거시 (미사용)
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  // 날짜별 독립 단계 선택 가능
  type MenuSel2 = { stage: StageType | null; volume: number | null; qtys: Record<MenuType, number> };
  const [menuSels, setMenuSels] = useState<Record<string, MenuSel2>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [completedId, setCompletedId] = useState<string | null>(null);
  const [earnedPoints, setEarnedPoints] = useState(0);
  const [usedPoints, setUsedPoints] = useState(0);
  // 포인트 사용 (결제 시)
  const [availablePoints, setAvailablePoints] = useState(0);
  const [usePoints, setUsePoints] = useState(0);

  const dateOpts = useMemo(() => weekDateOptions(weekOffset), [weekOffset]);
  const currentWeekStart = useMemo(() => weekMonday(weekOffset), [weekOffset]);
  const recStage = useMemo(() => months ? recommendStage(parseInt(months)) : null, [months]);

  // 저장 정보 로드 — 최초 1회
  useEffect(() => {
    const s = loadSaved();
    if (s?.babyName && s?.phone) {
      setBabyName(s.babyName); setMonths(s.months);
      setPhone(s.phone); setAddress(s.address);
      setAddressDetail(s.addressDetail); setDoorPw(s.doorPw);
      setSavedInfo(s);
    }
    // 알레르기 로드 — 전용 키 우선, 없으면 savedInfo에서
    try {
      const a = localStorage.getItem('bfo_allergies');
      if (a) setAllergies(JSON.parse(a));
      else if (s?.allergies) setAllergies(s.allergies);
    } catch {}
    setDiary(loadDiary());
    setLastOrder(loadLastOrder());
    setReactions(loadReactions());
    setSymptoms(loadSymptoms());

    // 배송상태 알림 감지 — 저장된 전화번호로 최근 주문 상태 확인
    const digits = (s?.phone || '').replace(/\D/g, '');
    if (/^\d{10,11}$/.test(digits) && s?.babyName) {
      fetch(`/api/my?phone=${digits}&name=${encodeURIComponent(s.babyName)}`).then(r => r.json()).then(d => {
        if (!d?.ok || !Array.isArray(d.orders)) return;
        const seen = loadSeenStatus();
        const firstTime = !hasSeenStatusRecord();
        const NOTABLE = ['준비중', '배송완료', '취소'];
        const alerts: { id: string; status: string; delivery_date: string }[] = [];
        const nextSeen: Record<string, string> = { ...seen };
        for (const o of d.orders) {
          nextSeen[o.id] = o.status;
          if (!firstTime && seen[o.id] !== o.status && NOTABLE.includes(o.status)) {
            alerts.push({ id: o.id, status: o.status, delivery_date: o.delivery_date });
          }
        }
        if (firstTime) saveSeenStatus(nextSeen); // 첫 방문은 조용히 기록만
        else if (alerts.length > 0) setStatusAlerts(alerts);
        else saveSeenStatus(nextSeen);
      }).catch(() => {});
    }
  }, []);

  // 주차별 메뉴 fetch — weekOffset 변경 시 재실행
  useEffect(() => {
    fetch(`/api/menus/current?week=${currentWeekStart}`)
      .then(r => r.json())
      .then(d => { if (d.menus) setWeeklyMenus(d.menus); }).catch(() => {});

    const SB_URL = 'https://ymghmfkqctckxxysxkvy.supabase.co';
    const KEY = 'sb_publishable_3-9zobXqx6Nv36LzmNMBpA_fohZqA5x';
    fetch(`${SB_URL}/rest/v1/kkakung_history?id=eq.${currentWeekStart}&select=id,yusik`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
    }).then(r => r.json()).then(rows => {
      if (!rows?.[0]?.yusik?.schedule) { setDayMenus([]); return; }
      const schedule: any[] = rows[0].yusik.schedule;
      const TYPE_KOR: Record<string, string> = { hanwoo:'한우', chicken:'닭', p3:'기타단백질' };
      const FIXED_SUFFIX: Record<string, string[]> = {
        hanwoo: ['한우육수','양파','채소상탕'],
        chicken: ['닭육수','양파','채소상탕'],
        p3: ['양파','채소상탕']
      };
      const MAIN_PROTEIN: Record<string, string[]> = {
        hanwoo: ['한우'], chicken: ['닭가슴살','닭']
      };
      function normalizeIngr(raw: string, type: string): string {
        const all = raw.split(',').map((s:string)=>s.trim()).filter(Boolean);
        const suffix = FIXED_SUFFIX[type] ?? [];
        const mainList = MAIN_PROTEIN[type] ?? [];
        const withoutSuffix = all.filter((s:string) => !suffix.includes(s));
        let mainItem = '';
        const middle: string[] = [];
        for (const s of withoutSuffix) {
          if (!mainItem && (mainList.includes(s) || (type==='p3' && !mainItem))) { mainItem=s; }
          else { middle.push(s); }
        }
        return [mainItem, ...middle, ...suffix].filter(Boolean).join(', ');
      }
      const opts = allWeekDays(weekOffset);
      const days: DayMenu[] = opts.filter(o => !o.past).map(opt => {
        const dayData = schedule.find((s:any) => s.date === opt.value);
        if (opt.isBanchan) {
          return {
            date: opt.value, label: opt.label, dow: opt.dow, menus: [],
            banchan: (dayData?.items || []).map((it:any) => ({ name: it.name || '', ingredients: it.ingredients || '' })),
            soup: dayData?.soup ? { name: dayData.soup.name || '', ingredients: dayData.soup.ingredients || '' } : undefined
          };
        }
        const menus = (dayData?.menus || []).map((m:any) => ({
          name: m.name || '',
          type: TYPE_KOR[m.type] || m.type,
          ingredients: normalizeIngr(m.ingredients || '', m.type || '')
        }));
        return { date: opt.value, label: opt.label, dow: opt.dow, menus };
      });
      setDayMenus(days);
    }).catch(() => setDayMenus([]));
  }, [currentWeekStart]);

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [step, mode]);

  // 확인 단계 진입 시 보유 포인트 조회
  useEffect(() => {
    if (step !== 4) return;
    const digits = phone.replace(/\D/g, '');
    if (!/^\d{10,11}$/.test(digits) || !babyName.trim()) { setAvailablePoints(0); return; }
    fetch(`/api/my?phone=${digits}&name=${encodeURIComponent(babyName.trim())}`).then(r => r.json())
      .then(d => setAvailablePoints(d?.customer?.points || 0)).catch(() => setAvailablePoints(0));
  }, [step, phone, babyName]);

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

  // ③ 지난번과 똑같이 주문 — 메뉴 구성 복원 후 날짜만 새로 선택
  function reorderLast() {
    if (!lastOrder) return;
    const restored: DateOrder[] = [{
      id: uid(), delivery_date: '',
      sets: lastOrder.sets.map(s => ({
        id: uid(), stage: s.stage, volume: s.volume,
        menus: { 한우: s.menus?.한우 ?? 0, 닭: s.menus?.닭 ?? 0, 기타단백질: s.menus?.기타단백질 ?? 0 },
        ...(s.simpleQty ? { _simpleQty: s.simpleQty } : {}),
      })),
    }];
    setDateOrders(restored);
    setSimpleMode(false);
    if (savedInfo) {
      setBabyName(savedInfo.babyName); setMonths(savedInfo.months);
      setPhone(savedInfo.phone); setAddress(savedInfo.address);
      setAddressDetail(savedInfo.addressDetail); setDoorPw(savedInfo.doorPw);
    }
    goMode('order');
    goStep(savedInfo ? 3 : 1);
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

  // 배송 그룹별 합산 팩수 (_simpleQty 포함)
  function groupQtys(): Record<string, number> {
    const g: Record<string, number> = {};
    for (const d of dateOrders) {
      if (!d.delivery_date) continue;
      const key = deliveryGroup(d.delivery_date);
      g[key] = (g[key] || 0) + dateQty(d);
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
          delivery_date: firstDate, order_type: '일반',
          allergies: allergies.map(k => allergenByKey(k)?.label).filter(Boolean),
          use_points: usePoints
        })
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '저장 실패');
      const firstSet = dateOrders[0]?.sets[0];
      doSave({
        babyName: babyName.trim(), months, phone: phone.replace(/[^\d]/g,''),
        address: address.trim(), addressDetail: addressDetail.trim(), doorPw: doorPw.trim(),
        lastStage: firstSet?.stage ?? undefined,
        lastVolume: firstSet?.volume ?? undefined,
        allergies
      });
      // ③⑥ 재주문용 마지막 주문 저장
      const savedSets: SavedSet[] = dateOrders.flatMap(d =>
        d.sets.filter(s => s.stage).map(s => ({
          stage: s.stage, volume: s.volume, menus: s.menus, simpleQty: s._simpleQty,
        }))
      );
      if (savedSets.length > 0) { saveLastOrder(savedSets); setLastOrder(loadLastOrder()); }
      setEarnedPoints(d.points_earned || 0);
      setUsedPoints(d.points_used || 0);
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

        {/* 배송상태 알림 배너 */}
        {statusAlerts.length > 0 && (
          <div className="mb-3 space-y-2">
            {statusAlerts.map(a => {
              const info = a.status === '배송완료'
                ? { emoji: '✅', text: '배송이 완료됐어요!', cls: 'bg-emerald-50 border-emerald-200 text-emerald-800' }
                : a.status === '준비중'
                  ? { emoji: '🧑‍🍳', text: '주문을 준비하고 있어요!', cls: 'bg-blue-50 border-blue-200 text-blue-800' }
                  : { emoji: '❌', text: '주문이 취소됐어요', cls: 'bg-stone-100 border-stone-200 text-stone-600' };
              return (
                <div key={a.id} className={`rounded-xl border px-4 py-3 text-sm font-bold flex items-center justify-between gap-2 ${info.cls}`}>
                  <span>{info.emoji} {a.delivery_date} 배송분 — {info.text}</span>
                </div>
              );
            })}
            <button onClick={dismissAlerts} className="w-full py-1.5 text-[11px] text-stone-400 underline underline-offset-2">확인했어요</button>
          </div>
        )}
        {/* ⑥ 재주문 리마인더 */}
        {(() => {
          const dsl = daysSinceLastOrder(lastOrder);
          if (dsl === null || dsl < 5) return null;
          return (
            <div className="mb-3 bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 text-xs text-orange-800 leading-relaxed">
              🔔 마지막 주문한 지 <span className="font-bold">{dsl}일</span> 됐어요. 이유식 떨어질 때 아니에요? 아래 <span className="font-bold">‘지난번과 똑같이’</span>로 빠르게 주문하세요.
            </div>
          );
        })()}

        {/* ⑤ 성장단계 전환 안내 */}
        {savedInfo && (() => {
          const note = stageTransitionNote(parseInt(savedInfo.months || '0'), savedInfo.lastStage);
          if (!note) return null;
          return (
            <div className="mb-3 bg-sky-50 border border-sky-200 rounded-xl px-4 py-3 text-xs text-sky-800 leading-relaxed">
              🌱 {note}
            </div>
          );
        })()}

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
            onClick={() => goMode('calendar')}
            className="w-full py-4 bg-white border-2 border-violet-200 rounded-2xl text-violet-800 font-bold text-sm shadow-sm hover:border-violet-400 transition"
          >
            <div className="text-xl mb-0.5">📅</div>
            한 달 식단표
            <div className="text-[11px] text-violet-400 font-normal mt-0.5">다가오는 4주 메뉴 한눈에</div>
          </button>
          <button
            onClick={() => { goMode('mypage'); const p = savedInfo?.phone || ''; const nm = savedInfo?.babyName || ''; if (p) setMyPhone(p); if (nm) setMyName(nm); if (p && nm) fetchMyOrders(p, nm); }}
            className="w-full py-4 bg-white border-2 border-stone-200 rounded-2xl text-stone-700 font-bold text-sm shadow-sm hover:border-stone-400 transition"
          >
            <div className="text-xl mb-0.5">📦</div>
            내 주문 조회
            <div className="text-[11px] text-stone-400 font-normal mt-0.5">배송상태 · 선결제 잔액 확인</div>
          </button>
          <button
            onClick={() => { goMode('album'); refreshAlbum(); }}
            className="w-full py-4 bg-white border-2 border-pink-200 rounded-2xl text-pink-800 font-bold text-sm shadow-sm hover:border-pink-400 transition"
          >
            <div className="text-xl mb-0.5">📸</div>
            이유식 성장앨범
            <div className="text-[11px] text-pink-400 font-normal mt-0.5">우리 아기 먹방 기록 · 내 폰에만 저장</div>
          </button>
          <button
            onClick={() => goMode('order')}
            className="w-full py-5 bg-amber-500 rounded-2xl text-white font-bold text-base shadow-sm active:bg-amber-600 transition"
          >
            <div className="text-2xl mb-1">✏️</div>
            주문하기
            <div className="text-xs text-amber-100 font-normal mt-0.5">날짜·단계·메뉴 직접 선택</div>
          </button>
          {/* ③ 원클릭 재주문 */}
          {lastOrder && lastOrder.sets.length > 0 && (
            <button
              onClick={reorderLast}
              className="w-full py-4 bg-white border-2 border-emerald-200 rounded-2xl text-emerald-800 font-bold text-sm shadow-sm hover:border-emerald-400 transition"
            >
              <div className="text-xl mb-0.5">🔁</div>
              지난번과 똑같이 주문
              <div className="text-[11px] text-emerald-500 font-normal mt-0.5">메뉴 그대로 · 날짜만 새로 선택</div>
            </button>
          )}
        </div>

        <div className="mt-3 space-y-3">
          <AllergyEditor allergies={allergies} toggle={toggleAllergy} open={allergyOpen} setOpen={setAllergyOpen} />
          <FoodDiary diary={diary} update={updateFood} open={diaryOpen} setOpen={setDiaryOpen}
            symptoms={symptoms} onLog={logSymptom} onDel={delSymptom} />
        </div>
      </Wrap>
    );
  }

  // ── 메뉴보기 화면 ─────────────────────────────────────────────
  if (mode === 'menu') {
    // 날짜별 독립 helpers
    const menuSelOf = (date: string): MenuSel2 =>
      menuSels[date] ?? { stage: null, volume: null, qtys: emptyMenus() };
    const updMenuSel = (date: string, fn: (s: MenuSel2) => MenuSel2) =>
      setMenuSels(prev => ({ ...prev, [date]: fn(prev[date] ?? { stage: null, volume: null, qtys: emptyMenus() }) }));

    const totalMenuQty = Object.values(menuSels).reduce((s, sel) =>
      s + Object.values(sel.qtys).reduce((a, b) => a + b, 0), 0)
      + Object.values(banchanQtys).reduce((a, b) => a + b, 0);
    const totalMenuPrice = Object.values(menuSels).reduce((s, sel) => {
      if (!sel.stage || !sel.volume) return s;
      return s + getPrice(sel.stage, sel.volume) * Object.values(sel.qtys).reduce((a, b) => a + b, 0);
    }, 0) + Object.entries(banchanQtys).reduce((s, [, q]) => s + q * BANCHAN_PRICE, 0);

    const goOrderFromMenu = () => {
      const yushikOrders: DateOrder[] = Object.entries(menuSels)
        .filter(([, sel]) => sel.stage && sel.volume && Object.values(sel.qtys).some(q => q > 0))
        .map(([date, sel]) => ({
          id: uid(), delivery_date: date,
          sets: [{ id: uid(), stage: sel.stage!, volume: sel.volume!, menus: sel.qtys }]
        }));
      const banchanOrders: DateOrder[] = Object.entries(banchanQtys)
        .filter(([, qty]) => qty > 0)
        .map(([date, qty]) => ({
          id: uid(), delivery_date: date,
          sets: [{ id: uid(), stage: '반찬세트' as any, volume: 0 as any, menus: emptyMenus(), _simpleQty: qty }]
        }));
      const allOrders = [...yushikOrders, ...banchanOrders];
      if (allOrders.length === 0) return;
      setDateOrders(allOrders);
      goMode('order');
      goStep(savedInfo ? 4 : 1);
    };

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

        <p className="text-xs text-stone-500 mb-3">날짜 탭 → 단계·용량 선택 → 메뉴별 수량 · 날짜마다 다른 단계·용량 가능</p>

        {dayMenus.length === 0 ? (
          <div className="text-center py-10 text-stone-400 text-sm">이번 주 메뉴가 아직 등록되지 않았어요</div>
        ) : (
          <div className="space-y-2">
            {dayMenus.map(day => {
              const isBanchan = !!day.banchan;
              const isOpen = expandedDate === day.date;
              const sel = menuSelOf(day.date);
              const bQty = banchanQtys[day.date] ?? 0;
              const dayQty = isBanchan ? bQty : Object.values(sel.qtys).reduce((a,b)=>a+b,0);
              const dayPrice = isBanchan ? bQty * BANCHAN_PRICE : (sel.stage && sel.volume ? getPrice(sel.stage, sel.volume) * dayQty : 0);
              const selVolOpts = sel.stage ? STAGE_OPTIONS[sel.stage] : [];
              return (
                <div key={day.date} className={`bg-white rounded-xl border overflow-hidden ${isBanchan ? 'border-emerald-200' : 'border-amber-100'}`}>
                  {/* 날짜 헤더 */}
                  <button
                    className="w-full flex items-center justify-between px-4 py-3 text-left"
                    onClick={() => setExpandedDate(isOpen ? null : day.date)}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-stone-900 text-sm">{day.label}</span>
                      {isBanchan && <span className="text-[10px] text-emerald-600 font-bold bg-emerald-50 px-1.5 py-0.5 rounded">반찬</span>}
                      {!isBanchan && sel.stage && <span className="text-[10px] text-stone-500">{sel.stage}{sel.volume ? ` ${sel.volume}g` : ''}</span>}
                      {dayQty > 0 && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-bold text-white ${isBanchan ? 'bg-emerald-500' : 'bg-amber-500'}`}>
                          {isBanchan ? `${dayQty}세트` : `${dayQty}팩`} · {dayPrice.toLocaleString()}원
                        </span>
                      )}
                    </div>
                    <span className="text-stone-400 text-lg">{isOpen ? '∧' : '∨'}</span>
                  </button>

                  {isOpen && (
                    <div className="px-4 pb-4 border-t border-amber-50 pt-3 space-y-3">
                      {/* 반찬 날 */}
                      {isBanchan && (
                        <div className="space-y-3">
                          <div className="text-xs text-stone-500 font-medium">🍱 반찬 세트 · {BANCHAN_PRICE.toLocaleString()}원/세트</div>
                          {(day.banchan!.length > 0 || day.soup) ? (
                            <div className="bg-emerald-50 rounded-lg p-3 space-y-1 text-xs text-stone-700">
                              {day.banchan!.map((b, i) => (
                                <div key={i}>
                                  <span className="font-bold">{i+1}. {b.name}</span>
                                  <AllergyBadge ingredients={b.ingredients} allergies={allergies} />
                                </div>
                              ))}
                              {day.soup && (
                                <div className="pt-1 border-t border-emerald-100">
                                  <span className="font-bold">국. {day.soup.name}</span>
                                  <AllergyBadge ingredients={day.soup.ingredients} allergies={allergies} />
                                </div>
                              )}
                            </div>
                          ) : <div className="text-xs text-stone-400 py-2">반찬 메뉴 준비 중</div>}
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-bold text-stone-700">세트 수량</span>
                            <QtyCtrl value={bQty} onChange={v => setBanchanQtys(prev => ({ ...prev, [day.date]: Math.max(0, v) }))} />
                          </div>
                          {bQty > 0 && <div className="text-xs text-emerald-700 font-bold text-right">{bQty}세트 · {(bQty * BANCHAN_PRICE).toLocaleString()}원</div>}
                        </div>
                      )}

                      {/* 이유식 단계 선택 */}
                      {!isBanchan && <div>
                        <div className="text-[11px] text-stone-500 mb-1.5">단계</div>
                        <div className="grid grid-cols-4 gap-1.5">
                          {STAGES.map(st => (
                            <button key={st}
                              onClick={() => updMenuSel(day.date, s => ({ ...s, stage: st, volume: null, qtys: emptyMenus() }))}
                              className={`py-2 rounded-lg text-xs font-bold border transition ${sel.stage===st?'bg-amber-500 border-amber-500 text-white':'bg-white border-amber-100 text-stone-700'}`}>
                              {st.replace('중기1단계','중1').replace('중기2단계','중2').replace('후기','후기').replace('완료기','완료')}
                            </button>
                          ))}
                        </div>
                      </div>}

                      {/* 이유식 용량 선택 */}
                      {!isBanchan && sel.stage && (
                        <div>
                          <div className="text-[11px] text-stone-500 mb-1.5">용량</div>
                          <div className="flex gap-2">
                            {selVolOpts.map(opt => (
                              <button key={opt.volume}
                                onClick={() => updMenuSel(day.date, s => ({ ...s, volume: opt.volume, qtys: emptyMenus() }))}
                                className={`flex-1 py-2 rounded-xl border text-xs font-bold transition ${sel.volume===opt.volume?'bg-amber-500 border-amber-500 text-white':'bg-white border-amber-100 text-stone-700'}`}>
                                {opt.volume}g<br/>
                                <span className="font-normal">{opt.price.toLocaleString()}원</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 이유식 메뉴별 수량 */}
                      {!isBanchan && sel.volume && day.menus.map((m, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={`flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                                m.type==='한우'?'bg-amber-100 text-amber-800':m.type==='닭'?'bg-emerald-100 text-emerald-800':'bg-violet-100 text-violet-800'}`}>
                                {m.type}
                              </span>
                              <span className="text-sm font-medium text-stone-900 truncate">{m.name}</span>
                              {reactions[m.name] === 'like' && <span className="flex-shrink-0 text-[10px]">👍</span>}
                            </div>
                            <div className="text-[11px] text-stone-500 mt-0.5 pl-0.5 truncate">{m.ingredients}</div>
                            <AllergyBadge ingredients={m.ingredients} allergies={allergies} />
                            <ReactionCtrl name={m.name} current={reactions[m.name]} onRate={rateMenu} />
                          </div>
                          <QtyCtrl
                            value={sel.qtys[m.type as MenuType] ?? 0}
                            onChange={v => updMenuSel(day.date, s => ({ ...s, qtys: { ...s.qtys, [m.type as MenuType]: Math.max(0, Math.min(10, v)) } }))}
                          />
                        </div>
                      ))}
                      {!isBanchan && !sel.volume && (
                        <div className="text-xs text-stone-400">단계와 용량을 먼저 선택해주세요</div>
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
              {(() => {
                const bTotal = Object.values(banchanQtys).reduce((a,b)=>a+b,0);
                const yTotal = totalMenuQty - bTotal;
                const parts = [];
                if (yTotal > 0) parts.push(`이유식 ${yTotal}팩`);
                if (bTotal > 0) parts.push(`반찬 ${bTotal}세트`);
                return `${parts.join(' · ')} · ${totalMenuPrice.toLocaleString()}원 — 주문하기 →`;
              })()}
            </button>
          </div>
        )}
        <div className="h-24" />
      </Wrap>
    );
  }

  // ── 월간 식단 캘린더 화면 ─────────────────────────────────────
  if (mode === 'calendar') {
    return (
      <Wrap>
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => goMode('home')} className="text-stone-400 text-lg">←</button>
          <h1 className="text-lg font-bold text-stone-900 flex-1">한 달 식단표</h1>
        </div>
        <p className="text-xs text-stone-500 mb-3">다가오는 4주 조리 메뉴예요. 날짜를 누르면 메뉴가 펼쳐지고, 바로 주문하러 갈 수 있어요.</p>
        <MonthCalendar reactions={reactions} allergies={allergies} onGoOrder={() => goMode('menu')} />
      </Wrap>
    );
  }

  // ── 내 주문 조회 화면 (D 배송상태 + ⑦ 선결제 잔액) ────────────
  if (mode === 'mypage') {
    const STATUS_STYLE: Record<string, string> = {
      '접수': 'bg-amber-100 text-amber-800',
      '준비중': 'bg-blue-100 text-blue-800',
      '배송완료': 'bg-emerald-100 text-emerald-800',
      '취소': 'bg-stone-100 text-stone-500',
    };
    const cust = myData?.customer;
    const lowBalance = cust && cust.prepaid_balance > 0 && cust.prepaid_balance <= 5;
    return (
      <Wrap>
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => goMode('home')} className="text-stone-400 text-lg">←</button>
          <h1 className="text-lg font-bold text-stone-900 flex-1">내 주문 조회</h1>
        </div>

        {/* 전화번호 + 아기 이름 입력 (2요소 확인) */}
        <div className="space-y-2 mb-4">
          <input value={myName} onChange={e => setMyName(e.target.value)} maxLength={15}
            placeholder="아기 이름"
            className="w-full px-3.5 py-3 bg-white border border-stone-200 rounded-xl outline-none focus:border-amber-500 text-[16px]" />
          <div className="flex gap-2">
            <input value={myPhone} onChange={e => setMyPhone(e.target.value)} inputMode="numeric" maxLength={13}
              placeholder="주문한 연락처 (010-0000-0000)"
              className="flex-1 px-3.5 py-3 bg-white border border-stone-200 rounded-xl outline-none focus:border-amber-500 text-[16px]" />
            <button onClick={() => fetchMyOrders(myPhone)} disabled={myLoading}
              className="px-5 py-3 bg-amber-500 text-white font-bold rounded-xl disabled:bg-stone-200">
              {myLoading ? '…' : '조회'}
            </button>
          </div>
        </div>
        {myError && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{myError}</div>}

        {myData && (
          <>
            {/* G 포인트 + ⑦ 선결제 잔액 */}
            {cust && (
              <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="rounded-xl border border-violet-200 bg-violet-50 p-4">
                  <div className="text-[11px] text-violet-500 font-bold mb-0.5">💜 적립 포인트</div>
                  <div className="text-lg font-black text-violet-700">{(cust.points || 0).toLocaleString()}P</div>
                  <div className="text-[10px] text-violet-400 mt-0.5">주문할 때마다 3% 적립</div>
                </div>
                <div className={`rounded-xl border p-4 ${lowBalance ? 'bg-rose-50 border-rose-200' : 'bg-amber-50 border-amber-200'}`}>
                  <div className="text-[11px] text-stone-500 font-bold mb-0.5">선결제 잔여</div>
                  <div className={`text-lg font-black ${lowBalance ? 'text-rose-600' : 'text-amber-700'}`}>{cust.prepaid_balance || 0}팩</div>
                  {cust.is_regular
                    ? <div className="text-[10px] text-emerald-600 font-bold mt-0.5">🔁 정기배송 이용중</div>
                    : lowBalance
                      ? <div className="text-[10px] text-rose-600 font-bold mt-0.5">⚠️ 소진 임박</div>
                      : <div className="text-[10px] text-stone-400 mt-0.5">{cust.baby_name || ''}</div>}
                </div>
              </div>
            )}

            {/* ⑧ 정기배송 신청 */}
            <RegularSetup phone={myPhone.replace(/\D/g, '')} initial={cust} onSaved={() => fetchMyOrders(myPhone)} />

            {/* D 주문 목록 + 상태 */}
            {myData.orders.length === 0 ? (
              <div className="text-center py-10 text-stone-400 text-sm">해당 연락처의 주문 내역이 없어요</div>
            ) : (
              <div className="space-y-2">
                {myData.orders.map((o: any) => (
                  <div key={o.id} className="bg-white rounded-xl border border-stone-200 p-3.5">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-bold text-stone-900">{o.delivery_date} 배송</span>
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${STATUS_STYLE[o.status] || 'bg-stone-100 text-stone-500'}`}>
                        {o.status}
                      </span>
                    </div>
                    <div className="text-xs text-stone-500">
                      총 {o.total_qty}팩 · {o.total_price.toLocaleString()}원
                      {o.order_type !== '일반' && <span className="ml-2 text-purple-600">{o.order_type}</span>}
                    </div>
                    {o.allergies && o.allergies.length > 0 && (
                      <div className="text-[10px] text-rose-600 mt-1">🚫 {o.allergies.join(', ')}</div>
                    )}
                    <div className="text-[10px] text-stone-300 mt-1">주문 {new Date(o.created_at).toLocaleDateString('ko-KR')} · {o.id.slice(0, 8)}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Wrap>
    );
  }

  // ── 성장앨범 화면 (E, 기기 저장) ──────────────────────────────
  if (mode === 'album') {
    return (
      <Wrap>
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => goMode('home')} className="text-stone-400 text-lg">←</button>
          <h1 className="text-lg font-bold text-stone-900 flex-1">이유식 성장앨범</h1>
        </div>
        <div className="bg-pink-50 border border-pink-200 rounded-xl px-3.5 py-2.5 text-[11px] text-pink-700 mb-4 leading-relaxed">
          🔒 사진은 <span className="font-bold">이 휴대폰 안에만</span> 저장돼요. 서버·사장님에게 올라가지 않아 안전해요. (기기를 바꾸면 사진은 옮겨지지 않아요)
        </div>

        {/* 사진 추가 */}
        <div className="bg-white rounded-2xl border border-pink-100 p-4 mb-4 space-y-2">
          <input value={albumNote} onChange={e => setAlbumNote(e.target.value)} maxLength={100}
            placeholder="메모 (예: 오늘 한우죽 잘 먹었어요)" className={iCls} />
          <label className={`block w-full py-3 text-center rounded-xl font-bold text-sm cursor-pointer ${albumBusy ? 'bg-stone-200 text-stone-400' : 'bg-pink-500 text-white active:bg-pink-600'}`}>
            {albumBusy ? '저장 중…' : '📷 사진 추가하기'}
            <input type="file" accept="image/*" capture="environment" className="hidden" disabled={albumBusy}
              onChange={e => onAddPhoto(e.target.files?.[0])} />
          </label>
        </div>

        {/* 갤러리 */}
        {photos.length === 0 ? (
          <div className="text-center py-10 text-stone-400 text-sm">아직 사진이 없어요.<br />첫 이유식 순간을 남겨보세요 📸</div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {photos.map(p => (
              <div key={p.id} className="bg-white rounded-xl border border-pink-100 overflow-hidden">
                <div className="relative">
                  <img src={p.url} alt={p.note} className="w-full aspect-square object-cover" />
                  <button onClick={() => onDeletePhoto(p.id)}
                    className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/50 text-white text-xs flex items-center justify-center">✕</button>
                </div>
                <div className="p-2">
                  <div className="text-[10px] text-stone-400">{p.date}</div>
                  {p.note && <div className="text-[11px] text-stone-700 mt-0.5 line-clamp-2">{p.note}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
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
              {usedPoints > 0 && (
                <div className="flex justify-between text-xs text-violet-600 font-normal mb-0.5">
                  <span>포인트 사용</span><span>-{usedPoints.toLocaleString()}P</span>
                </div>
              )}
              합계 {totalQty}팩 · {(totalPrice - usedPoints).toLocaleString()}원
            </div>
          </div>
          {(earnedPoints > 0 || usedPoints > 0) && (
            <div className="bg-violet-50 border border-violet-200 rounded-xl px-4 py-2.5 text-sm font-bold text-violet-700 mb-3">
              {usedPoints > 0 && <span>💜 {usedPoints.toLocaleString()}P 사용</span>}
              {usedPoints > 0 && earnedPoints > 0 && <span> · </span>}
              {earnedPoints > 0 && <span>{earnedPoints.toLocaleString()}P 적립됐어요!</span>}
            </div>
          )}
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
          {savedInfo ? (
            /* 저장된 정보 있음 — 바로 주문하기만 표시, 폼 숨김 */
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
              <div className="text-xs text-amber-700 font-bold mb-1">이전 주문 정보가 있어요</div>
              <div className="text-sm text-stone-700 mb-4 leading-relaxed">
                <span className="font-bold">{savedInfo.babyName}</span> · {formatPhone(savedInfo.phone)}<br/>
                <span className="text-xs text-stone-500">{savedInfo.address}</span>
              </div>
              <button onClick={applySaved}
                className="w-full py-4 bg-amber-500 text-white font-bold rounded-xl text-base mb-3 shadow-sm active:bg-amber-600">
                이 정보로 바로 주문하기 →
              </button>
              <button onClick={() => setSavedInfo(null)}
                className="w-full py-2.5 border border-amber-300 text-amber-700 text-sm font-medium rounded-xl bg-white">
                새로 입력할게요
              </button>
            </div>
          ) : (
            /* 저장 정보 없음 or 새로 입력 선택 — 폼 표시 */
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
              {months && parseInt(months) > 0 && recommendStage(parseInt(months)) && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5 text-xs text-amber-800 leading-relaxed">
                  <span className="font-bold">✨ {babyName || '아기'}에게 추천: {recommendStage(parseInt(months))}</span>
                  <br /><span className="text-amber-600">{stageGuide(parseInt(months))} · 주문할 때 자동으로 골라드려요</span>
                </div>
              )}
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
          )}
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

      {/* ── Step 3 copyMode: 날짜만 선택 ─────────── */}
      {step === 3 && copyMode && (() => {
            const source = dateOrders[dateOrders.length - 1];
            const usedDates = new Set(dateOrders.map(d => d.delivery_date));
            const available = dateOpts.filter(o => !o.past && !usedDates.has(o.value));

            // 기존 주문 요약
            const summaryText = (o: DateOrder) => {
              const qs = o.sets.map(s => {
                const q = setQtyTotal(s);
                return s.stage ? `${s.stage} ${s.volume}g ${q}팩` : `${q}팩`;
              }).join(' · ');
              return `${o.delivery_date} · ${qs}`;
            };

            return (
              <div>
                <h2 className="text-lg font-bold text-stone-900 mb-3">날짜 추가</h2>
                {/* 기존 주문 접힌 요약 */}
                <div className="space-y-1.5 mb-4">
                  {dateOrders.map(o => (
                    <div key={o.id} className="bg-amber-50 rounded-lg px-3 py-2 text-xs text-stone-600 flex items-center justify-between">
                      <span>{summaryText(o)}</span>
                      <span className="text-amber-500 font-bold">{datePrice(o).toLocaleString()}원</span>
                    </div>
                  ))}
                </div>

                {/* 날짜 선택 — 탭하면 즉시 추가 */}
                <div className="text-xs text-stone-500 mb-2">추가할 날짜를 선택해주세요</div>
                {available.length === 0 ? (
                  <div className="text-sm text-stone-400 text-center py-6">추가 가능한 날짜가 없어요</div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {available.map(opt => (
                      <button key={opt.value}
                        onClick={() => {
                          const copied: DateOrder = {
                            id: uid(),
                            delivery_date: opt.value,
                            sets: source.sets.map(s => ({ ...s, id: uid(), menus: { ...s.menus } }))
                          };
                          setDateOrders(prev => [...prev, copied]);
                          setCopyMode(false);
                          goStep(4); // 바로 확인으로
                        }}
                        className="py-3 bg-white border border-amber-200 rounded-xl text-sm font-bold text-stone-900 hover:bg-amber-50 hover:border-amber-400 transition">
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}

                <button onClick={() => { setCopyMode(false); goStep(4); }}
                  className="w-full mt-4 py-3 text-sm text-stone-500 border border-stone-200 rounded-xl">
                  취소 — 확인 화면으로 돌아가기
                </button>
              </div>
            );
      })()}

      {/* ── Step 3 주문 구성 ─────────────────────── */}
      {step === 3 && !copyMode && (
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
            // dateOpts: useMemo로 weekOffset 변경 시 자동 갱신 (IIFE 내 직접 계산 금지)
            const opts = dateOpts;
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
                                    className={`py-1.5 rounded-lg text-xs border ${it.volume===opt2.volume?'bg-amber-500 border-amber-500 text-white':'bg-white border-amber-100 text-stone-700'}`}>
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
                                    className={`relative py-2 rounded-lg text-xs font-bold border transition ${s.stage===st?'bg-amber-500 border-amber-500 text-white':'bg-white border-amber-100 text-stone-700'}`}>
                                    {st}
                                    {recStage===st && s.stage!==st && (
                                      <span className="absolute -top-1.5 -right-1 text-[9px] bg-rose-500 text-white font-bold px-1 py-0.5 rounded-full leading-none">추천</span>
                                    )}
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
                                      className={`py-2 rounded-lg text-xs border transition ${s.volume===opt.volume?'bg-amber-500 border-amber-500 text-white':'bg-white border-amber-100 text-stone-700'}`}>
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
                                          {wm && <div className="text-[11px] text-stone-500">{wm.vegetables}</div>}
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
                    className="w-full py-2.5 border border-amber-300 text-amber-700 text-sm font-medium rounded-xl bg-white shadow-sm active:shadow-none">
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
            className="w-full mt-3 py-3.5 border border-amber-300 text-amber-700 font-bold rounded-2xl bg-white shadow-sm active:shadow-none">
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
              {/* 합배송 토글 */}
              {(() => {
                const canCombine = dateOrders.filter(d => d.delivery_date).length >= 2;
                return (
                  <div className="mt-2">
                    <button
                      onClick={() => canCombine && setCombinedDelivery(v => !v)}
                      className={`w-full py-2 text-xs rounded-lg border transition ${combinedDelivery ? 'bg-amber-100 border-amber-300 text-amber-800 font-bold' : canCombine ? 'bg-white border-stone-200 text-stone-500 hover:border-amber-300' : 'bg-white border-stone-100 text-stone-300 cursor-not-allowed'}`}
                    >
                      {combinedDelivery ? '✓ 합배송 적용 중 (월+화 / 목+금 묶음)' : '합배송 신청 (월+화 또는 목+금 묶어서 1회 배송)'}
                    </button>
                    {!canCombine && (
                      <p className="text-[10px] text-stone-400 text-center mt-1">날짜를 2개 이상 선택해야 활성화됩니다</p>
                    )}
                  </div>
                );
              })()}
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
              {d.sets.filter(s=>s.stage&&(s.volume||(s.stage as any)==='반찬세트')).map(s => (
                <div key={s.id} className="pl-3 mb-1 text-stone-700">
                  {(s.stage as any)==='반찬세트'
                    ? <span className="font-medium text-emerald-700">반찬 세트 {s._simpleQty}세트 · {((s._simpleQty??0)*BANCHAN_PRICE).toLocaleString()}원</span>
                    : <><span className="font-medium">{s.stage} {s.volume}g</span>{' — '}{s._simpleQty?`${s._simpleQty}팩`:MENU_TYPES.filter(m=>s.menus[m]>0).map(m=>`${m} ${s.menus[m]}팩`).join(' · ')}</>
                  }
                </div>
              ))}
            </div>
          ))}

          {/* 같은 내용으로 다른 날짜 추가 */}
          <button
            onClick={() => {
              setCopyMode(true);
              goStep(3);
            }}
            className="w-full mb-3 py-3 border border-amber-300 text-amber-700 text-sm font-bold rounded-xl bg-white shadow-sm"
          >
            + 같은 내용으로 다른 날짜 추가
          </button>

          {/* 포인트 사용 */}
          {availablePoints > 0 && (() => {
            const orderTotal = dateOrders.reduce((s, d) => s + datePrice(d), 0);
            const maxUse = Math.min(availablePoints, orderTotal);
            return (
              <div className="bg-violet-50 border border-violet-200 rounded-xl p-3 mb-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-bold text-violet-700">💜 포인트 사용</span>
                  <span className="text-xs text-violet-500">보유 {availablePoints.toLocaleString()}P</span>
                </div>
                <div className="flex items-center gap-2">
                  <input inputMode="numeric" value={usePoints || ''}
                    onChange={e => setUsePoints(Math.min(maxUse, Math.max(0, parseInt(e.target.value.replace(/\D/g, '')) || 0)))}
                    placeholder="0" className="flex-1 px-3 py-2 bg-white border border-violet-200 rounded-lg text-[16px] outline-none focus:border-violet-400" />
                  <span className="text-sm text-violet-600 font-bold">P</span>
                  <button onClick={() => setUsePoints(maxUse)}
                    className="px-3 py-2 bg-violet-500 text-white text-xs font-bold rounded-lg">전액</button>
                </div>
                {usePoints > 0 && <div className="text-xs text-violet-600 font-bold mt-1.5 text-right">-{usePoints.toLocaleString()}P 할인 적용</div>}
              </div>
            );
          })()}

          <div className="bg-stone-800 text-white rounded-xl px-4 py-3 mb-4">
            <div className="flex justify-between text-sm font-bold">
              <span>전체 {dateOrders.reduce((s,d)=>s+dateQty(d),0)}팩</span>
              <span>{(dateOrders.reduce((s,d)=>s+datePrice(d),0) - usePoints).toLocaleString()}원</span>
            </div>
            {usePoints > 0 && (
              <div className="flex justify-between text-[11px] text-stone-400 mt-1">
                <span>{dateOrders.reduce((s,d)=>s+datePrice(d),0).toLocaleString()}원 − 포인트 {usePoints.toLocaleString()}P</span>
              </div>
            )}
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

// ── ⑧ 정기배송 신청 ──────────────────────────────────────────────
function RegularSetup({ phone, initial, onSaved }: {
  phone: string;
  initial: { is_regular?: boolean; regular_schedule?: any } | null;
  onSaved: () => void;
}) {
  const sched = initial?.regular_schedule || {};
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<StageType | null>(sched.stage ?? null);
  const [volume, setVolume] = useState<number | null>(sched.volume ?? null);
  const initQtys: Record<string, number> = { 월: 0, 화: 0, 목: 0, 금: 0 };
  (sched.slots || []).forEach((s: any) => { if (s.day in initQtys) initQtys[s.day] = s.qty; });
  const [qtys, setQtys] = useState<Record<string, number>>(initQtys);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const isActive = !!initial?.is_regular;

  async function save(active: boolean) {
    setSaving(true); setMsg(null);
    try {
      const slots = Object.entries(qtys).filter(([, q]) => q > 0).map(([day, qty]) => ({ day, qty }));
      const r = await fetch('/api/my/regular', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, active, stage, volume, slots }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '저장 실패');
      setMsg(active ? '정기배송이 신청됐어요!' : '정기배송이 해지됐어요');
      onSaved();
    } catch (e: any) { setMsg(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="bg-white rounded-2xl border border-emerald-200 overflow-hidden mb-4">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <div className="flex items-center gap-2">
          <span className="text-lg">🔁</span>
          <span className="text-sm font-bold text-stone-800">정기배송</span>
          {isActive
            ? <span className="text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">이용중</span>
            : <span className="text-[11px] text-stone-400">미신청</span>}
        </div>
        <span className="text-stone-400 text-sm">{open ? '∧' : '∨'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-emerald-50 pt-3 space-y-3">
          <p className="text-[11px] text-stone-500 leading-relaxed">
            매주 원하는 요일·수량을 등록하면 자동으로 주문돼요. 단계·용량과 요일별 팩 수를 골라주세요.
          </p>
          {/* 단계 */}
          <div className="grid grid-cols-4 gap-1.5">
            {STAGES.map(st => (
              <button key={st} onClick={() => { setStage(st); setVolume(null); }}
                className={`py-2 rounded-lg text-[11px] font-bold border ${stage === st ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-stone-200 text-stone-600'}`}>
                {st.replace('중기1단계', '중1').replace('중기2단계', '중2').replace('완료기', '완료')}
              </button>
            ))}
          </div>
          {/* 용량 */}
          {stage && (
            <div className="grid grid-cols-2 gap-1.5">
              {STAGE_OPTIONS[stage].map(o => (
                <button key={o.volume} onClick={() => setVolume(o.volume)}
                  className={`py-2 rounded-lg text-xs border ${volume === o.volume ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-stone-200 text-stone-600'}`}>
                  {o.volume}g · {o.price.toLocaleString()}원
                </button>
              ))}
            </div>
          )}
          {/* 요일별 수량 */}
          <div className="space-y-1.5">
            {['월', '화', '목', '금'].map(day => (
              <div key={day} className="flex items-center justify-between bg-stone-50 rounded-lg px-3 py-1.5">
                <span className="text-sm font-bold text-stone-700">{day}요일</span>
                <QtyCtrl value={qtys[day]} onChange={v => setQtys(p => ({ ...p, [day]: Math.max(0, Math.min(10, v)) }))} />
              </div>
            ))}
          </div>
          {msg && <div className="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">{msg}</div>}
          <div className="flex gap-2">
            <button onClick={() => save(true)} disabled={saving || !stage || !volume}
              className="flex-1 py-2.5 bg-emerald-500 text-white text-sm font-bold rounded-xl disabled:bg-stone-200">
              {saving ? '저장 중…' : isActive ? '변경 저장' : '정기배송 신청'}
            </button>
            {isActive && (
              <button onClick={() => save(false)} disabled={saving}
                className="px-4 py-2.5 border border-stone-200 text-stone-500 text-sm font-medium rounded-xl">해지</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── C. 월간 식단 캘린더 (4주치 kkakung_history 조회) ──────────────
function MonthCalendar({
  reactions, allergies, onGoOrder,
}: { reactions: MenuReactions; allergies: string[]; onGoOrder: () => void }) {
  const [byDate, setByDate] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [openDate, setOpenDate] = useState<string | null>(null);
  const TYPE_KOR: Record<string, string> = { hanwoo: '한우', chicken: '닭', p3: '기타단백질' };
  const DOW_KOR: Record<number, string> = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금' };

  const weeks = useMemo(() => [0, 1, 2, 3].map(w => weekMonday(w)), []);
  const todayStr = useMemo(() => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10), []);

  useEffect(() => {
    const SB = 'https://ymghmfkqctckxxysxkvy.supabase.co';
    const KEY = 'sb_publishable_3-9zobXqx6Nv36LzmNMBpA_fohZqA5x';
    Promise.all(weeks.map(mon =>
      fetch(`${SB}/rest/v1/kkakung_history?id=eq.${mon}&select=id,yusik`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      }).then(r => r.json()).catch(() => [])
    )).then(results => {
      const map: Record<string, any> = {};
      results.forEach(rows => {
        const sched = rows?.[0]?.yusik?.schedule;
        if (Array.isArray(sched)) sched.forEach((d: any) => { if (d.date) map[d.date] = d; });
      });
      setByDate(map);
      setLoading(false);
    });
  }, [weeks]);

  if (loading) return <div className="text-center py-10 text-stone-400 text-sm">식단을 불러오는 중…</div>;

  return (
    <div className="space-y-4">
      {weeks.map((mon, wi) => {
        const monTs = new Date(mon + 'T00:00:00Z').getTime();
        // 월~금 (0~4)
        const days = [0, 1, 2, 3, 4].map(off => {
          const ts = monTs + off * 86400000;
          const d = new Date(ts);
          const value = d.toISOString().slice(0, 10);
          const dow = d.getUTCDay();
          return { value, dow, label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, data: byDate[value] };
        });
        const monD = new Date(monTs);
        return (
          <div key={mon}>
            <div className="text-xs font-bold text-violet-700 mb-2">
              {wi === 0 ? '이번 주' : wi === 1 ? '다음 주' : `${monD.getUTCMonth() + 1}/${monD.getUTCDate()} 주`}
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {days.map(day => {
                const isBanchan = day.dow === 3;
                const menus = day.data?.menus || [];
                const hasBanchan = isBanchan && (day.data?.items?.length || day.data?.soup);
                const has = menus.length > 0 || hasBanchan;
                const isPast = day.value < todayStr;
                const isOpen = openDate === day.value;
                return (
                  <button key={day.value} onClick={() => has && setOpenDate(isOpen ? null : day.value)}
                    className={`rounded-lg border p-1.5 text-left min-h-[52px] transition ${
                      isPast ? 'bg-stone-50 border-stone-100 opacity-50'
                      : isBanchan ? 'bg-emerald-50 border-emerald-200'
                      : has ? 'bg-white border-violet-200 hover:border-violet-400' : 'bg-stone-50 border-stone-100'}`}>
                    <div className="text-[10px] font-bold text-stone-500">{day.label}({DOW_KOR[day.dow]})</div>
                    {isBanchan ? (
                      <div className="text-[9px] text-emerald-600 font-bold mt-0.5">{hasBanchan ? '반찬' : ''}</div>
                    ) : has ? (
                      <div className="flex flex-wrap gap-0.5 mt-0.5">
                        {menus.slice(0, 3).map((m: any, i: number) => (
                          <span key={i} className={`text-[8px] font-bold px-1 py-0.5 rounded ${
                            TYPE_KOR[m.type] === '한우' ? 'bg-amber-100 text-amber-800'
                            : TYPE_KOR[m.type] === '닭' ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-violet-100 text-violet-800'}`}>
                            {TYPE_KOR[m.type] || m.type}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[9px] text-stone-300 mt-0.5">예정</div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 펼친 날짜 상세 */}
            {days.some(d => d.value === openDate) && (() => {
              const day = days.find(d => d.value === openDate)!;
              const menus = day.data?.menus || [];
              return (
                <div className="mt-2 bg-white border border-violet-200 rounded-xl p-3 space-y-2">
                  <div className="text-xs font-bold text-violet-700">{day.label}({DOW_KOR[day.dow]}) 메뉴</div>
                  {day.dow === 3 ? (
                    <div className="text-xs text-stone-700 space-y-1">
                      {(day.data?.items || []).map((it: any, i: number) => (
                        <div key={i}>🍱 {it.name}<AllergyBadge ingredients={it.ingredients || ''} allergies={allergies} /></div>
                      ))}
                      {day.data?.soup && <div>🍲 {day.data.soup.name}</div>}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {menus.map((m: any, i: number) => (
                        <div key={i} className="text-xs text-stone-700">
                          <span className="font-bold">{TYPE_KOR[m.type] || m.type}</span> · {m.name}
                          {reactions[m.name] === 'like' && ' 👍'}
                          <div className="text-[10px] text-stone-400">{m.ingredients}</div>
                          <AllergyBadge ingredients={m.ingredients || ''} allergies={allergies} />
                        </div>
                      ))}
                    </div>
                  )}
                  <button onClick={onGoOrder} className="w-full py-2 bg-violet-500 text-white text-xs font-bold rounded-lg">이 메뉴 주문하러 가기 →</button>
                </div>
              );
            })()}
          </div>
        );
      })}
    </div>
  );
}

// ── 공통 컴포넌트 ─────────────────────────────────────────────────
function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="max-w-md mx-auto px-4 py-6 pb-36">{children}</div>;
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
    <button onClick={()=>onChange(value-1)} disabled={value<=0} className="w-9 h-9 rounded-lg bg-amber-100 text-amber-800 font-black text-xl leading-none disabled:opacity-30 flex items-center justify-center">−</button>
    <span className="w-7 text-center font-bold text-stone-900 text-base">{value}</span>
    <button onClick={()=>onChange(value+1)} disabled={value>=10} className="w-9 h-9 rounded-lg bg-amber-100 text-amber-800 font-black text-xl leading-none disabled:opacity-30 flex items-center justify-center">+</button>
  </div>;
}
// ── 알레르기 등록 UI ──────────────────────────────────────────────
function AllergyEditor({
  allergies, toggle, open, setOpen,
}: { allergies: string[]; toggle: (k: string) => void; open: boolean; setOpen: (v: boolean) => void }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? ALLERGENS : ALLERGENS.filter(a => COMMON_KEYS.includes(a.key) || allergies.includes(a.key));
  return (
    <div className="bg-white rounded-2xl border border-rose-100 overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <div className="flex items-center gap-2">
          <span className="text-lg">🚫</span>
          <span className="text-sm font-bold text-stone-800">알레르기 설정</span>
          {allergies.length > 0
            ? <span className="text-[11px] font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full">{allergies.length}개 등록</span>
            : <span className="text-[11px] text-stone-400">미설정</span>}
        </div>
        <span className="text-stone-400 text-sm">{open ? '∧' : '∨'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-rose-50 pt-3">
          <p className="text-[11px] text-stone-500 mb-3 leading-relaxed">
            아기가 못 먹는 재료를 골라두면, 메뉴에 그 재료가 들어있을 때 <span className="text-rose-600 font-bold">빨간 경고</span>로 알려드려요. 한 번 설정하면 계속 유지되고, 다시 눌러 해제할 수 있어요.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {shown.map(a => {
              const on = allergies.includes(a.key);
              return (
                <button key={a.key} onClick={() => toggle(a.key)}
                  className={`px-2.5 py-1.5 rounded-full text-xs font-medium border transition ${
                    on ? 'bg-rose-500 border-rose-500 text-white' : 'bg-white border-stone-200 text-stone-600 hover:border-rose-300'}`}>
                  {a.emoji} {a.label}{on ? ' ✓' : ''}
                </button>
              );
            })}
          </div>
          {!showAll && (
            <button onClick={() => setShowAll(true)} className="mt-3 text-[11px] text-rose-500 underline underline-offset-2">
              + 더 많은 재료 보기 (전체 {ALLERGENS.length}종)
            </button>
          )}
          {allergies.length > 0 && (
            <div className="mt-3 text-[11px] text-stone-500">
              등록됨: {allergies.map(k => allergenByKey(k)?.label).filter(Boolean).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 재료 도감 (먹어본 재료 트래킹 + 알레르기 첫도입 도우미 + 이상반응 기록) ──
function FoodDiary({
  diary, update, open, setOpen, symptoms, onLog, onDel,
}: {
  diary: Diary; update: (k: string, s: FoodStatus) => void; open: boolean; setOpen: (v: boolean) => void;
  symptoms: SymptomEntry[]; onLog: (foodKey: string, symptom: string) => void; onDel: (idx: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [logKey, setLogKey] = useState<string>(''); // 이상반응 기록할 재료 선택
  const safe = foodKeysByStatus(diary, 'safe');
  const testing = foodKeysByStatus(diary, 'testing');
  const allergic = foodKeysByStatus(diary, 'allergic');
  const shown = showAll
    ? ALLERGENS
    : ALLERGENS.filter(a => COMMON_KEYS.includes(a.key) || diary[a.key]);
  return (
    <div className="bg-white rounded-2xl border border-emerald-100 overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <div className="flex items-center gap-2">
          <span className="text-lg">📖</span>
          <span className="text-sm font-bold text-stone-800">우리 아기 재료 도감</span>
          <span className="text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">먹어본 {safe.length}종</span>
        </div>
        <span className="text-stone-400 text-sm">{open ? '∧' : '∨'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-emerald-50 pt-3 space-y-3">
          <p className="text-[11px] text-stone-500 leading-relaxed">
            새 재료는 <span className="font-bold text-amber-600">🧪 테스트</span>로 시작하세요. 한 번에 한 가지만, <span className="font-bold">3일간</span> 이상반응(발진·설사 등)을 관찰하는 게 안전해요. 괜찮으면 <span className="font-bold text-emerald-600">✅ 안전</span>, 이상하면 <span className="font-bold text-rose-600">🚫 알레르기</span> — 알레르기로 표시하면 메뉴 경고에 자동 반영돼요.
          </p>

          {/* 테스트중 — 3일 관찰 가이드 */}
          {testing.length > 0 && (
            <div className="bg-amber-50 rounded-xl p-3 space-y-2">
              <div className="text-[11px] font-bold text-amber-700">🧪 테스트 관찰중</div>
              {testing.map(k => {
                const a = allergenByKey(k); if (!a) return null;
                const days = testingDays(diary[k]);
                return (
                  <div key={k} className="flex items-center justify-between gap-2">
                    <div className="text-xs text-stone-700">
                      {a.emoji} {a.label}
                      <span className="ml-1 text-[10px] text-amber-600">
                        {days === 0 ? '오늘 시작' : `${days}일째`}{days >= 3 ? ' · 관찰 완료!' : ` (3일 중 ${days}일)`}
                      </span>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => update(k, 'safe')} className="text-[11px] font-bold text-emerald-700 bg-emerald-100 px-2 py-1 rounded">✅ 안전</button>
                      <button onClick={() => update(k, 'allergic')} className="text-[11px] font-bold text-rose-700 bg-rose-100 px-2 py-1 rounded">🚫 알레르기</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 요약 */}
          <div className="flex gap-2 text-[11px]">
            <span className="text-emerald-600">✅ 안전 {safe.length}</span>
            <span className="text-amber-600">🧪 테스트 {testing.length}</span>
            <span className="text-rose-600">🚫 알레르기 {allergic.length}</span>
          </div>

          {/* B. 이상반응 기록 */}
          <div className="bg-rose-50 rounded-xl p-3 space-y-2">
            <div className="text-[11px] font-bold text-rose-700">🩹 이상반응 기록</div>
            <p className="text-[10px] text-stone-500">재료를 고르고 증상을 누르면 오늘 날짜로 기록돼요.</p>
            <select value={logKey} onChange={e => setLogKey(e.target.value)}
              className="w-full text-xs border border-rose-200 rounded-lg px-2 py-1.5 bg-white">
              <option value="">재료 선택…</option>
              {ALLERGENS.map(a => <option key={a.key} value={a.key}>{a.emoji} {a.label}</option>)}
            </select>
            {logKey && (
              <div className="flex flex-wrap gap-1">
                {SYMPTOMS.map(sym => (
                  <button key={sym} onClick={() => { onLog(logKey, sym); setLogKey(''); }}
                    className="text-[11px] px-2 py-1 rounded-full bg-white border border-rose-200 text-rose-700 font-medium hover:bg-rose-100">
                    {sym}
                  </button>
                ))}
              </div>
            )}
            {symptoms.length > 0 && (
              <div className="space-y-1 pt-1 border-t border-rose-100">
                {symptoms.slice(0, 8).map((s, i) => (
                  <div key={i} className="flex items-center justify-between text-[11px] text-stone-600">
                    <span>{s.date} · <b>{allergenByKey(s.foodKey)?.label ?? s.foodKey}</b> → {s.symptom}</span>
                    <button onClick={() => onDel(i)} className="text-stone-300 px-1">✕</button>
                  </div>
                ))}
                {symptoms.length > 8 && <div className="text-[10px] text-stone-400">외 {symptoms.length - 8}건</div>}
              </div>
            )}
          </div>

          {/* 재료별 상태 지정 */}
          <div className="space-y-1.5">
            {shown.map(a => {
              const st = diary[a.key]?.status ?? 'none';
              return (
                <div key={a.key} className="flex items-center justify-between gap-2">
                  <span className={`text-xs font-medium ${st === 'allergic' ? 'text-rose-600' : st === 'safe' ? 'text-emerald-700' : 'text-stone-600'}`}>
                    {a.emoji} {a.label}
                  </span>
                  <div className="flex gap-1">
                    <StatBtn on={st === 'testing'} onClick={() => update(a.key, st === 'testing' ? 'none' : 'testing')} cls="amber">🧪</StatBtn>
                    <StatBtn on={st === 'safe'} onClick={() => update(a.key, st === 'safe' ? 'none' : 'safe')} cls="emerald">✅</StatBtn>
                    <StatBtn on={st === 'allergic'} onClick={() => update(a.key, st === 'allergic' ? 'none' : 'allergic')} cls="rose">🚫</StatBtn>
                  </div>
                </div>
              );
            })}
          </div>
          {!showAll && (
            <button onClick={() => setShowAll(true)} className="text-[11px] text-emerald-600 underline underline-offset-2">
              + 더 많은 재료 보기 (전체 {ALLERGENS.length}종)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
function StatBtn({ on, onClick, cls, children }: { on: boolean; onClick: () => void; cls: string; children: React.ReactNode }) {
  const active: Record<string, string> = {
    amber: 'bg-amber-500 border-amber-500', emerald: 'bg-emerald-500 border-emerald-500', rose: 'bg-rose-500 border-rose-500',
  };
  return (
    <button onClick={onClick}
      className={`w-7 h-7 rounded-lg border text-xs flex items-center justify-center transition ${on ? active[cls] + ' scale-110' : 'bg-white border-stone-200 opacity-50 hover:opacity-100'}`}>
      {children}
    </button>
  );
}

// A. 메뉴 반응 기록 컨트롤 (먹은 뒤 아기 반응)
function ReactionCtrl({ name, current, onRate }: { name: string; current?: MenuReaction; onRate: (n: string, r: MenuReaction) => void }) {
  const opts: { r: MenuReaction; emoji: string; label: string }[] = [
    { r: 'like', emoji: '👍', label: '잘먹음' },
    { r: 'meh', emoji: '😐', label: '보통' },
    { r: 'dislike', emoji: '👎', label: '안먹음' },
  ];
  return (
    <div className="mt-1 flex items-center gap-1">
      <span className="text-[10px] text-stone-400">먹은 반응:</span>
      {opts.map(o => (
        <button key={o.r} onClick={(e) => { e.stopPropagation(); onRate(name, o.r); }}
          className={`text-[11px] px-1.5 py-0.5 rounded border transition ${
            current === o.r ? 'bg-amber-100 border-amber-300 font-bold' : 'bg-white border-stone-200 opacity-60 hover:opacity-100'}`}>
          {o.emoji}
        </button>
      ))}
    </div>
  );
}

// 메뉴 재료에 걸린 알레르겐 경고 배지
function AllergyBadge({ ingredients, allergies }: { ingredients: string; allergies: string[] }) {
  const hits = matchAllergens(ingredients, allergies);
  if (hits.length === 0) return null;
  return (
    <div className="mt-1 flex items-center gap-1 flex-wrap">
      <span className="text-[10px] font-bold text-rose-600 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded">
        ⚠️ 알레르기 주의
      </span>
      {hits.map(h => (
        <span key={h.key} className="text-[10px] font-bold text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded">
          {h.emoji} {h.label}
        </span>
      ))}
    </div>
  );
}

const iCls = 'w-full px-3.5 py-3 bg-white border border-amber-100 rounded-xl outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100 transition text-[16px]';
const iSmCls = 'w-full px-3 py-2.5 bg-white border border-amber-100 rounded-xl outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100 transition text-[16px]';
