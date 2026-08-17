'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  STAGES, STAGE_OPTIONS, MENU_TYPES, MIN_ORDER_QTY, getPrice, getBanchanPrice, tierOf, menuLabel, PACK_SURCHARGE,
  hanwooAllowed, othersNeededForHanwoo, HANWOO_MAX_RATIO,
  type StageType, type MenuType, type PriceTier
} from '@/lib/supabase';
import { weekDateOptions, weekMonday, deliveryDateOptions, formatPhone, allWeekDays, kstToday } from '@/lib/dates';
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
type AppMode = 'home' | 'menu' | 'order' | 'calendar' | 'mypage' | 'album' | 'review' | 'intro';
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
  postalCode?: string; zoneGroup?: string | null; deliveryKind?: string | null; // 배송권역
};

function loadSaved(): SavedInfo | null {
  try { const s = localStorage.getItem(SAVED_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}

// ── 배송지 주소록 ────────────────────────────────────────────────
// 주소를 하나만 저장하면 이사하거나 "이번만 친정으로" 받을 때 기존 주소를 덮어쓰게 되고,
// 그러면 다음 주문이 엉뚱한 곳으로 감. 여러 개 저장 + 기본 배송지 지정 방식으로 둔다.
export type SavedAddress = {
  id: string;
  label: string;              // 집 / 친정 등 손님이 붙이는 이름
  address: string;
  addressDetail: string;
  doorPw: string;
  postalCode?: string;
  zoneGroup?: string | null;
  deliveryKind?: string | null;
  isDefault?: boolean;
};
const ADDR_BOOK_KEY = 'bfo_address_book';

// 담던 주문 임시저장 — 날짜·메뉴를 다 골라놓고 전화가 와서 앱을 벗어나면 처음부터 다시
// 해야 했음. 큰 앱의 장바구니처럼 하루 동안 남겨둔다.
const DRAFT_KEY = 'bfo_order_draft';
const DRAFT_TTL = 24 * 3600 * 1000;
function saveDraft(dateOrders: unknown) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ at: Date.now(), dateOrders })); } catch {}
}
function loadDraft(): any[] | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d?.at || Date.now() - d.at > DRAFT_TTL) { localStorage.removeItem(DRAFT_KEY); return null; }
    return Array.isArray(d.dateOrders) ? d.dateOrders : null;
  } catch { return null; }
}
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} }

function loadAddrBook(): SavedAddress[] {
  try {
    const raw = localStorage.getItem(ADDR_BOOK_KEY);
    if (raw) return JSON.parse(raw);
    // 예전에 주소 하나만 저장해 쓰던 손님은 그 주소를 주소록 첫 항목으로 옮겨준다
    const s = loadSaved();
    if (s?.address) {
      const migrated: SavedAddress[] = [{
        id: 'a1', label: '기본 배송지', address: s.address, addressDetail: s.addressDetail || '',
        doorPw: s.doorPw || '', postalCode: s.postalCode, zoneGroup: s.zoneGroup,
        deliveryKind: s.deliveryKind, isDefault: true,
      }];
      localStorage.setItem(ADDR_BOOK_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch {}
  return [];
}
function saveAddrBook(list: SavedAddress[]) {
  try { localStorage.setItem(ADDR_BOOK_KEY, JSON.stringify(list)); } catch {}
}
const ACQ_SOURCE_KEY = 'bfo_acquisition_source'; // 유입경로 — 최초 1회만 기록(퍼스트터치)
const REF_CODE_KEY = 'bfo_referral_code'; // 공유링크(?ref=코드)로 들어온 추천인 코드
const INTRO_SEEN_KEY = 'bfo_intro_seen';
function introSeen(): boolean {
  try { return localStorage.getItem(INTRO_SEEN_KEY) === '1'; } catch { return true; }
}
function markIntroSeen() {
  try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch {}
}
function doSave(info: SavedInfo) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(info)); } catch {}
}

const STORE_NAME = (process.env.NEXT_PUBLIC_STORE_NAME || '까꿍디미방').trim();
// 가게 대표번호 — 값이 없으면 문의 버튼을 아예 안 띄운다(가짜 번호가 노출되면 안 되므로).
// Vercel 환경변수 NEXT_PUBLIC_STORE_CONTACT 에 넣으면 완료 화면에 전화 버튼이 생김.
const STORE_CONTACT = (process.env.NEXT_PUBLIC_STORE_CONTACT || '').trim();

// 추천인 전화번호를 텍스트에 그대로 노출하지 않고, 링크(?ref=코드)로 자동 적용되게 함
async function shareApp(phone?: string) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  let url = `${origin}/order`;
  let text = `${STORE_NAME} — 신선한 이유식을 집까지 배송해드려요 🍱`;

  const digits = (phone || '').replace(/\D/g, '');
  if (digits) {
    try {
      const r = await fetch('/api/my/referral-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: digits }),
      });
      const d = await r.json();
      if (d.ok && d.code) {
        url = `${origin}/order?ref=${d.code}`;
        text = `${STORE_NAME} 이유식 써봤는데 좋아서 추천해요! 이 링크로 첫 주문하면 서로 3,000P 받아요 🍱`;
      }
    } catch { /* 코드 발급 실패해도 그냥 일반 링크로 공유 */ }
  }

  if (typeof navigator !== 'undefined' && (navigator as any).share) {
    try { await (navigator as any).share({ title: STORE_NAME, text, url }); return; } catch { /* 사용자가 취소한 경우 등 — 무시 */ }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    alert('공유 문구를 복사했어요. 원하는 곳에 붙여넣어 주세요!');
  } catch {
    alert(url);
  }
}

// ── 배송상태 웹푸시 구독 ───────────────────────────────────────────
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function subscribePush(phone: string, babyName: string): Promise<'ok' | 'denied' | 'unsupported' | 'error'> {
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidKey || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return 'denied';
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource });
    const r = await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, baby_name: babyName, subscription: sub.toJSON() }),
    });
    const d = await r.json();
    return d.ok ? 'ok' : 'error';
  } catch (e) { console.error('[subscribePush]', e); return 'error'; }
}

// ── 헬퍼 ────────────────────────────────────────────────────────
let _uid = 0;
function uid() { return String(++_uid); }
function emptyMenus(): MenuSel { return { 한우: 0, 닭: 0, 기타단백질: 0 }; }
function newSet(): OrderSet { return { id: uid(), stage: null, volume: null, menus: emptyMenus() }; }
function newDate(): DateOrder { return { id: uid(), delivery_date: '', sets: [newSet()] }; }

function setQty(s: OrderSet, menu: MenuType, val: number): OrderSet {
  // _simpleQty(간단주문 팩수)가 남아있으면 상세 메뉴를 골라도 제출 시 무시되고 메뉴가 빈 채로
  // 나가버림 — 상세 메뉴를 직접 조작하는 순간 간단주문 흔적은 지운다.
  return { ...s, _simpleQty: undefined, menus: { ...s.menus, [menu]: Math.max(0, Math.min(10, val)) } };
}
function setQtyTotal(s: OrderSet): number {
  // ⚠️ Object.values(s.menus)로 전부 합치면 안 됨.
  // 제출 payload는 MENU_TYPES에 있는 키만 담는데(submit의 menus), 합계만 모든 키를 더하면
  // 주방이 안 쓰는 타입 키(예: 'other')가 섞였을 때 "돈은 3팩인데 조리표엔 2팩"이 된다.
  // 실제로 8/16 주문 2건이 그렇게 들어왔음(한우1+닭1인데 3팩·3팩값). 합계와 payload의
  // 기준을 MENU_TYPES 하나로 통일해서, 기록되지 않는 팩에는 절대 값을 매기지 않는다.
  return s._simpleQty ?? MENU_TYPES.reduce((a, m) => a + (s.menus[m] || 0), 0);
}
// ⚠️ 반찬 세트는 용량 개념이 없어서 volume=0으로 담기는데, 0은 falsy라 `s.volume` 체크에
// 전부 걸러져서 가격 합계·제출 데이터에서 통째로 빠져버렸음(반찬만 주문하면 합계 0원 →
// 서버가 "가격 계산 오류"로 거부). 아래 헬퍼로 반찬을 명시적으로 구분해서 처리한다.
function isBanchanSet(s: OrderSet): boolean {
  return (s.stage as any) === '반찬세트';
}
// 주문에 담긴 유효한 세트인지 — 이유식은 단계+용량이, 반찬은 단계만 있으면 됨
function isFilledSet(s: OrderSet): boolean {
  if (setQtyTotal(s) <= 0) return false;
  return isBanchanSet(s) ? true : !!(s.stage && s.volume);
}
function setPrice(s: OrderSet, tier: PriceTier): number {
  if (isBanchanSet(s)) return getBanchanPrice(tier) * setQtyTotal(s);
  if (!s.stage || !s.volume) return 0;
  return getPrice(s.stage, s.volume, tier) * setQtyTotal(s);
}
function dateQty(d: DateOrder): number {
  return d.sets.reduce((sum, s) => sum + setQtyTotal(s), 0);
}
function datePrice(d: DateOrder, tier: PriceTier): number {
  return d.sets.reduce((sum, s) => sum + setPrice(s, tier), 0);
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
    // UTC 기준이면 자정~오전9시(KST) 사이 기록이 하루 전으로 남아 알레르기 관찰 기간이 어긋남
    setSymptoms(addSymptom({ foodKey, symptom, date: kstToday() }));
  }
  function delSymptom(idx: number) { setSymptoms(removeSymptom(idx)); }

  // ── D+⑦. 내 주문 조회 ──────────────────────────────────────────
  const [myPhone, setMyPhone] = useState('');
  const [myName, setMyName] = useState('');
  const [myData, setMyData] = useState<{ orders: any[]; customer: any; mismatch?: boolean } | null>(null);
  const [myLoading, setMyLoading] = useState(false);
  const [myError, setMyError] = useState<string | null>(null);
  const [pushStatus, setPushStatus] = useState<'idle' | 'loading' | 'ok' | 'denied' | 'unsupported' | 'error'>('idle');
  async function handleSubscribePush() {
    setPushStatus('loading');
    const digits = myPhone.replace(/\D/g, '');
    const result = await subscribePush(digits, myName.trim());
    setPushStatus(result);
  }
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

  async function cancelMyOrder(orderId: string) {
    if (!confirm('이 주문을 취소할까요?')) return;
    try {
      const r = await fetch('/api/my/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId, phone: myPhone.replace(/\D/g, ''), baby_name: myName })
      });
      const d = await r.json();
      if (!r.ok || !d.ok) { alert(d.error || '취소 실패'); return; }
      fetchMyOrders(myPhone);
    } catch (e: any) { alert(e.message); }
  }

  // Step 1
  const [babyName, setBabyName] = useState('');
  const [months, setMonths] = useState('');

  // Step 2
  const [phone, setPhone] = useState('');
  const [referrerPhone, setReferrerPhone] = useState(''); // 친구초대: 추천인 연락처(선택, 첫 주문에만 적용)
  const [refCodeCaptured, setRefCodeCaptured] = useState(false); // 공유링크(?ref=코드)로 들어와서 자동 적용된 경우
  const [address, setAddress] = useState('');
  const [addressDetail, setAddressDetail] = useState('');
  const [doorPw, setDoorPw] = useState('');
  const [customerRequest, setCustomerRequest] = useState('');
  // 예전에 주문하신 손님이면(엑셀에서 가져온 3,148명) 주소를 다시 입력하지 않아도 되게
  const [knownAddr, setKnownAddr] = useState<{ address: string; door_password: string } | null>(null);
  // 배송지 여러 개를 저장해두고 골라 쓴다 — 이사하거나 이번만 친정으로 받는 경우가 흔한데
  // 주소가 하나뿐이면 매번 덮어쓰게 되고, 그러면 다음 주문이 엉뚱한 곳으로 감.
  const [addrBook, setAddrBook] = useState<SavedAddress[]>([]);
  const [selectedAddrId, setSelectedAddrId] = useState<string | null>(null);
  const [draftFound, setDraftFound] = useState<any[] | null>(null); // 담다 만 주문이 있으면 이어하기 제안
  // 배송권역: 직배송(강서·양천) / 당일배송(두발히어로) / 택배익일배송
  const [postalCode, setPostalCode] = useState('');
  // 배송은 1회 3팩부터. 1~2팩은 픽업(방문수령)만 가능해서 손님이 직접 고를 수 있게 함.
  const [isPickup, setIsPickup] = useState(false);
  const [zoneGroup, setZoneGroup] = useState<string | null>(null);
  const [deliveryKind, setDeliveryKind] = useState<string | null>(null); // '직배송'|'당일배송'|'택배익일배송'|null
  const [zoneChecking, setZoneChecking] = useState(false);
  const [zoneError, setZoneError] = useState(false); // 배송지역 조회 실패 여부
  // 마지막으로 검색한 주소 정보 — 배송지역 조회 실패 시 다시 시도용
  const [lastZoneArgs, setLastZoneArgs] = useState<{ zonecode: string; sido: string; sigungu: string } | null>(null);
  const DIRECT_GU = ['강서구', '양천구']; // 서울 자체 직배송 지역 (두발히어로 무관)
  // 지역 가격 tier (직배송=기본가 / 기타=+500). 픽업은 배송을 안 나가므로 항상 기본가 —
  // 서버(api/orders)도 픽업이면 '직배송' tier로 계산하니 화면 금액과 어긋나지 않게 여기서도 맞춘다.
  const tier: PriceTier = isPickup ? '직배송' : tierOf(deliveryKind);
  const addressReady = !!address && deliveryKind !== null; // 주소·지역 확정 여부 (가격 노출 조건)

  // 주소 선택 시 배송 종류 판별
  // 조회가 실패하면 예전엔 아무 안내 없이 deliveryKind만 null로 두고 다음 단계로 넘어갈 수 있었고,
  // 제출할 때 '당일배송'으로 기본값이 박혀서 실제로 당일배송이 안 되는 지역인데도 당일배송으로
  // 접수되는 문제가 있었음 — 실패를 화면에 알리고 다시 시도할 수 있게 함.
  async function resolveDelivery(zonecode: string, sido: string, sigungu: string) {
    const pc = String(zonecode || '').trim();
    const gu = String(sigungu || '');
    setZoneError(false);
    // 강서·양천(서울) → 직배송
    if (String(sido || '').includes('서울') && DIRECT_GU.some(g => gu.includes(g))) {
      setDeliveryKind('직배송'); setZoneGroup(null); return;
    }
    if (!/^\d{5}$/.test(pc)) { setDeliveryKind(null); setZoneGroup(null); setZoneError(true); return; }
    setZoneChecking(true); setDeliveryKind(null); setZoneGroup(null);
    try {
      const SB = 'https://ymghmfkqctckxxysxkvy.supabase.co';
      const KEY = 'sb_publishable_3-9zobXqx6Nv36LzmNMBpA_fohZqA5x';
      const r = await fetch(`${SB}/rest/v1/dubal_zones?postal_code=eq.${pc}&select=zone_group`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      });
      if (!r.ok) throw new Error('zone lookup failed');
      const rows = await r.json();
      if (Array.isArray(rows) && rows[0]?.zone_group) { setZoneGroup(rows[0].zone_group); setDeliveryKind('당일배송'); }
      else { setZoneGroup(null); setDeliveryKind('택배익일배송'); }
    } catch { setDeliveryKind(null); setZoneError(true); }
    finally { setZoneChecking(false); }
  }

  // 카카오(다음) 우편번호 검색 열기
  function openPostcode() {
    const daum = (window as any).daum;
    if (!daum?.Postcode) { alert('주소 검색을 불러오는 중이에요. 잠시 후 다시 눌러주세요.'); return; }
    new daum.Postcode({
      oncomplete: (data: any) => {
        setAddress(data.roadAddress || data.address || '');
        setPostalCode(data.zonecode || '');
        const args = { zonecode: data.zonecode || '', sido: data.sido || '', sigungu: data.sigungu || '' };
        setLastZoneArgs(args);
        resolveDelivery(args.zonecode, args.sido, args.sigungu);
      },
    }).open();
  }
  function retryResolveDelivery() {
    if (!lastZoneArgs) { openPostcode(); return; }
    resolveDelivery(lastZoneArgs.zonecode, lastZoneArgs.sido, lastZoneArgs.sigungu);
  }

  // ── 배송지 주소록 조작 ──────────────────────────────────────────
  function pickAddress(a: SavedAddress) {
    setSelectedAddrId(a.id);
    setAddress(a.address); setAddressDetail(a.addressDetail); setDoorPw(a.doorPw);
    setPostalCode(a.postalCode || '');
    setZoneGroup(a.zoneGroup ?? null);
    setDeliveryKind(a.deliveryKind ?? null);
    setZoneError(!a.deliveryKind); // 배송지역 정보가 없는 예전 주소면 다시 확인 필요
    setKnownAddr(null);
  }
  function setDefaultAddress(id: string) {
    const next = addrBook.map(a => ({ ...a, isDefault: a.id === id }));
    setAddrBook(next); saveAddrBook(next);
  }
  function removeAddress(id: string) {
    if (!confirm('이 배송지를 목록에서 지울까요?')) return;
    const next = addrBook.filter(a => a.id !== id);
    // 기본 배송지를 지웠으면 남은 첫 번째를 기본으로
    if (next.length && !next.some(a => a.isDefault)) next[0].isDefault = true;
    setAddrBook(next); saveAddrBook(next);
    if (selectedAddrId === id) {
      setSelectedAddrId(null);
      setAddress(''); setAddressDetail(''); setDoorPw('');
      setPostalCode(''); setZoneGroup(null); setDeliveryKind(null);
    }
  }
  function renameAddress(id: string) {
    const cur = addrBook.find(a => a.id === id);
    const label = prompt('배송지 이름 (예: 집, 친정, 회사)', cur?.label || '')?.trim();
    if (label === undefined || label === '') return;
    const next = addrBook.map(a => a.id === id ? { ...a, label: label.slice(0, 12) } : a);
    setAddrBook(next); saveAddrBook(next);
  }
  /** 주문에 사용한 주소를 주소록에 반영 (같은 주소면 갱신, 없으면 추가) */
  function rememberAddress() {
    const addr = address.trim();
    if (!addr) return;
    const same = addrBook.find(a => a.address.trim() === addr && a.addressDetail.trim() === addressDetail.trim());
    let next: SavedAddress[];
    if (same) {
      next = addrBook.map(a => a.id === same.id
        ? { ...a, doorPw: doorPw.trim(), postalCode, zoneGroup, deliveryKind } : a);
    } else {
      const entry: SavedAddress = {
        id: 'a' + Date.now(),
        label: addrBook.length === 0 ? '기본 배송지' : `배송지 ${addrBook.length + 1}`,
        address: addr, addressDetail: addressDetail.trim(), doorPw: doorPw.trim(),
        postalCode, zoneGroup, deliveryKind,
        isDefault: addrBook.length === 0,
      };
      next = [...addrBook, entry];
      setSelectedAddrId(entry.id);
    }
    setAddrBook(next); saveAddrBook(next);
  }

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
  const [menuLoading, setMenuLoading] = useState(true); // 불러오는 동안 빈 화면이라 고장난 줄 알았음
  const [weekOffset, setWeekOffset] = useState(0);
  const [banchanQtys, setBanchanQtys] = useState<Record<string, number>>({}); // 반찬 세트 수량

  // ── 메뉴보기 전용 상태 ───────────────────────────────────────────
  const [menuStage, setMenuStage] = useState<StageType | null>(null); // 레거시 (미사용)
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  // 날짜별 독립 단계 선택 가능
  // ⚠️ 예전엔 날짜당 stage·volume 하나에 qtys 하나만 들고 있어서, 단계나 용량을 바꾸면
  // 담아둔 수량이 리셋됐음 — 한 날짜에 중기1 240 + 중기1 310처럼 여러 조합을 시키는 손님이
  // 이 화면에서는 아예 주문을 못 했다. 조합(단계|용량)별로 따로 보관해서 전부 담을 수 있게 함.
  // stage·volume은 "지금 편집 중인 조합"을 가리키는 커서일 뿐, 바꿔도 담은 건 그대로 남는다.
  type MenuSel2 = {
    stage: StageType | null;
    volume: number | null;
    byCombo: Record<string, Record<MenuType, number>>; // '중기1단계|240' → {한우,닭,기타단백질}
  };
  const comboKey = (stage: StageType, volume: number) => `${stage}|${volume}`;
  const parseCombo = (key: string) => {
    const i = key.lastIndexOf('|');
    return { stage: key.slice(0, i) as StageType, volume: Number(key.slice(i + 1)) };
  };
  const comboQty = (q?: Record<MenuType, number>) => q ? MENU_TYPES.reduce((a, m) => a + (q[m] || 0), 0) : 0;
  const [menuSels, setMenuSels] = useState<Record<string, MenuSel2>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [completedId, setCompletedId] = useState<string | null>(null);
  const [earnedPoints, setEarnedPoints] = useState(0);
  const [usedPoints, setUsedPoints] = useState(0);
  const [welcomeBonus, setWelcomeBonus] = useState(0);
  const [referralBonusEarned, setReferralBonusEarned] = useState(0);
  // 포인트 사용 (결제 시)
  const [availablePoints, setAvailablePoints] = useState(0);
  const [usePoints, setUsePoints] = useState(0);

  // 후기 (홈 화면 티저 + 작성 화면)
  const [reviews, setReviews] = useState<{ id: string; baby_name: string; rating: number; content: string; created_at: string }[]>([]);
  const [reviewSummary, setReviewSummary] = useState<{ count: number; avg: number }>({ count: 0, avg: 0 });
  const [reviewPhone, setReviewPhone] = useState('');
  const [reviewBabyName, setReviewBabyName] = useState('');
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewContent, setReviewContent] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewDone, setReviewDone] = useState<number | null>(null); // 적립된 포인트(0이면 이미 작성한 적 있음)

  const dateOpts = useMemo(() => weekDateOptions(weekOffset), [weekOffset]);
  const currentWeekStart = useMemo(() => weekMonday(weekOffset), [weekOffset]);
  const recStage = useMemo(() => months ? recommendStage(parseInt(months)) : null, [months]);

  // 저장 정보 로드 — 최초 1회
  useEffect(() => {
    // 유입경로(?src=insta 등, 퍼스트터치만 기록) + 리퍼럴 링크(?ref=코드) 캡처
    try {
      const params = new URLSearchParams(window.location.search);
      const src = params.get('src') || params.get('utm_source');
      if (src && !localStorage.getItem(ACQ_SOURCE_KEY)) localStorage.setItem(ACQ_SOURCE_KEY, src.slice(0, 40));
      const ref = params.get('ref');
      if (ref) localStorage.setItem(REF_CODE_KEY, ref.slice(0, 20));
      if (localStorage.getItem(REF_CODE_KEY)) setRefCodeCaptured(true);
    } catch {}
    const s = loadSaved();
    if (s?.babyName && s?.phone) {
      setBabyName(s.babyName); setMonths(s.months);
      setPhone(s.phone); setAddress(s.address);
      setAddressDetail(s.addressDetail); setDoorPw(s.doorPw);
      if (s.postalCode) setPostalCode(s.postalCode);
      if (s.zoneGroup !== undefined) setZoneGroup(s.zoneGroup);
      if (s.deliveryKind !== undefined) setDeliveryKind(s.deliveryKind);
      setSavedInfo(s);
    } else if (!introSeen()) {
      // 처음 오는 방문자(주문 이력 없음)에게만 서비스 소개 화면을 먼저 보여줌
      setMode('intro');
    }
    // 알레르기 로드 — 전용 키 우선, 없으면 savedInfo에서
    try {
      const a = localStorage.getItem('bfo_allergies');
      if (a) setAllergies(JSON.parse(a));
      else if (s?.allergies) setAllergies(s.allergies);
    } catch {}
    // 배송지 주소록 — 기본 배송지가 있으면 그걸로 시작
    const book = loadAddrBook();
    setAddrBook(book);
    const def = book.find(a => a.isDefault) || book[0];
    if (def) {
      setSelectedAddrId(def.id);
      setAddress(def.address); setAddressDetail(def.addressDetail); setDoorPw(def.doorPw);
      if (def.postalCode) setPostalCode(def.postalCode);
      setZoneGroup(def.zoneGroup ?? null);
      setDeliveryKind(def.deliveryKind ?? null);
    }

    // 담다 만 주문이 있으면 이어할지 물어본다 (자동 복원하면 지난 선택이 섞일 수 있어 확인받음)
    const draft = loadDraft();
    if (draft && draft.length > 0 && draft.some((d: any) => d.delivery_date)) setDraftFound(draft);

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
        const NOTABLE = ['준비중', '배송중', '배송완료', '취소'];
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

    // 홈 화면 후기 티저용 — 승인된 후기 목록 + 평균별점
    fetch('/api/reviews').then(r => r.json()).then(d => { if (d.ok) { setReviews(d.reviews); setReviewSummary(d.summary); } }).catch(() => {});
  }, []);

  async function submitReview() {
    const digits = reviewPhone.replace(/\D/g, '');
    if (!/^\d{10,11}$/.test(digits)) { setReviewError('연락처를 정확히 입력해주세요'); return; }
    if (!reviewBabyName.trim()) { setReviewError('아기 이름을 입력해주세요'); return; }
    if (reviewContent.trim().length < 5) { setReviewError('후기 내용을 5자 이상 입력해주세요'); return; }
    setReviewSubmitting(true); setReviewError(null);
    try {
      const r = await fetch('/api/reviews', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_phone: digits, baby_name: reviewBabyName.trim(), rating: reviewRating, content: reviewContent.trim() })
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '등록 실패');
      setReviewDone(d.bonus || 0);
      fetch('/api/reviews').then(rr => rr.json()).then(dd => { if (dd.ok) { setReviews(dd.reviews); setReviewSummary(dd.summary); } }).catch(() => {});
    } catch (e: any) { setReviewError(e.message); }
    finally { setReviewSubmitting(false); }
  }

  // 주차별 메뉴 fetch — weekOffset 변경 시 재실행
  useEffect(() => {
    setMenuLoading(true); // 주차를 바꾸면 이전 주 메뉴가 잠깐 남아 보여서 다시 로딩 표시
    fetch(`/api/menus/current?week=${currentWeekStart}`)
      .then(r => r.json())
      .then(d => { if (d.menus) setWeeklyMenus(d.menus); }).catch(() => {});

    const SB_URL = 'https://ymghmfkqctckxxysxkvy.supabase.co';
    const KEY = 'sb_publishable_3-9zobXqx6Nv36LzmNMBpA_fohZqA5x';
    fetch(`${SB_URL}/rest/v1/kkakung_history?id=eq.${currentWeekStart}&select=id,yusik`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
    }).then(r => r.json()).then(rows => {
      setMenuLoading(false);
      if (!rows?.[0]?.yusik?.schedule) { setDayMenus([]); return; }
      const schedule: any[] = rows[0].yusik.schedule;
      // ⚠️ 주방에서 넣는 세 번째 메뉴 타입은 실제로 'other'인데 'p3'만 매핑돼 있어서,
      // 기타단백질이 '기타단백질' 키로 안 들어가고 'other'라는 엉뚱한 키로 들어갔음.
      // 그 결과 수량·금액에는 포함되는데(Object.values 합산) 화면·조리표에는 표기가 빠지고
      // 조리표에서는 "메뉴 미지정"으로 잡혔음. 두 표기를 모두 받아준다.
      const TYPE_KOR: Record<string, string> = { hanwoo:'한우', chicken:'닭', p3:'기타단백질', other:'기타단백질' };
      const FIXED_SUFFIX: Record<string, string[]> = {
        hanwoo: ['한우육수','양파','채소상탕'],
        chicken: ['닭육수','양파','채소상탕'],
        p3: ['양파','채소상탕'],
        other: ['양파','채소상탕']
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
          if (!mainItem && (mainList.includes(s) || ((type==='p3'||type==='other') && !mainItem))) { mainItem=s; }
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
    }).catch(() => { setMenuLoading(false); setDayMenus([]); });
  }, [currentWeekStart]);

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [step, mode]);

  // 담는 내용이 바뀔 때마다 임시저장 (주문이 끝나면 지움)
  useEffect(() => {
    if (completedId) return;
    const hasSomething = dateOrders.some(d => d.delivery_date && completeSets(d).length > 0);
    if (hasSomething) saveDraft(dateOrders);
  }, [dateOrders, completedId]);

  // 배송정보 단계에서 연락처를 다 넣으면, 예전 주문 이력으로 주소를 찾아본다.
  // (이름까지 맞아야 서버가 돌려주므로 남의 주소는 조회되지 않음)
  useEffect(() => {
    if (step !== 2) return;
    const digits = phone.replace(/\D/g, '');
    const nm = babyName.trim();
    if (!/^\d{10,11}$/.test(digits) || !nm || address) { setKnownAddr(null); return; }
    let alive = true;
    fetch('/api/known-customer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: digits, baby_name: nm }),
    }).then(r => r.json()).then(d => {
      if (alive && d.found && d.address) setKnownAddr({ address: d.address, door_password: d.door_password || '' });
    }).catch(() => {});
    return () => { alive = false; };
  }, [step, phone, babyName, address]);

  // 카카오(다음) 우편번호 스크립트 로드
  useEffect(() => {
    if ((window as any).daum?.Postcode) return;
    const s = document.createElement('script');
    s.src = 'https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
    s.async = true;
    document.body.appendChild(s);
  }, []);

  // 확인 단계 진입 시 보유 포인트 조회
  useEffect(() => {
    if (step !== 4) return;
    const digits = phone.replace(/\D/g, '');
    if (!/^\d{10,11}$/.test(digits) || !babyName.trim()) { setAvailablePoints(0); return; }
    fetch(`/api/my?phone=${digits}&name=${encodeURIComponent(babyName.trim())}`).then(r => r.json())
      .then(d => setAvailablePoints(d?.customer?.points || 0)).catch(() => setAvailablePoints(0));
  }, [step, phone, babyName]);

  // 포인트 입력칸은 입력 시점 기준으로만 상한을 걸어서, 포인트를 넣어둔 뒤 뒤로 가서 수량을
  // 줄이면 사용액이 주문금액보다 커진 채로 남아 결제금액이 마이너스로 표시됐음 —
  // 주문 내용/보유 포인트가 바뀔 때마다 다시 상한을 적용한다.
  useEffect(() => {
    const orderTotal = dateOrders.reduce((s, d) => s + datePrice(d, tier), 0);
    const maxUse = Math.min(availablePoints, orderTotal);
    setUsePoints(prev => (prev > maxUse ? Math.max(0, maxUse) : prev));
  }, [dateOrders, tier, availablePoints]);

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
    if (savedInfo.postalCode) setPostalCode(savedInfo.postalCode);
    if (savedInfo.zoneGroup !== undefined) setZoneGroup(savedInfo.zoneGroup);
    if (savedInfo.deliveryKind !== undefined) setDeliveryKind(savedInfo.deliveryKind);
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

  // 내역에 있는 "이 주문"을 그대로 다시 담기 — 홈의 '지난번과 똑같이'는 마지막 주문만 되지만,
  // 실제로는 "2주 전 그 구성"으로 돌아가고 싶다는 경우가 많음.
  // 서버 items는 두 가지 모양(옛 평면 / 날짜별 중첩)이 섞여 있어서 둘 다 받아준다.
  function reorderFromHistory(o: any) {
    const sets: OrderSet[] = [];
    const items = Array.isArray(o?.items) ? o.items : [];
    let skippedBanchan = false;
    for (const it of items) {
      if (Array.isArray(it?.sets)) {
        // 중첩형: 날짜별 → 세트
        for (const s of it.sets) {
          // 반찬세트는 STAGES에 없어서 주문 화면에서 단계 버튼이 하나도 안 잡힌다(수요일 전용).
          // 그대로 되살리면 "단계 미선택"처럼 보이는 고장난 카드가 되므로 메뉴보기로 보낸다.
          if (s?.stage === '반찬세트') { skippedBanchan = true; continue; }
          const menus = emptyMenus();
          for (const m of (s.menus || [])) if (m?.menu in menus) menus[m.menu as MenuType] = Number(m.qty) || 0;
          const filled = Object.values(menus).reduce((a, b) => a + b, 0);
          sets.push({
            id: uid(), stage: s.stage ?? null, volume: s.volume ?? null, menus,
            ...(filled === 0 && s.qty ? { _simpleQty: Number(s.qty) || 0 } : {}),
          });
        }
      }
    }
    if (sets.length === 0) {
      if (skippedBanchan) {
        alert('반찬 세트는 수요일 메뉴에서 골라주세요.');
        goMode('menu');
      } else {
        // 평면형(옛 주문)은 단계·용량 정보가 없어 복원 불가 — 새로 고르게 안내
        alert('예전 방식으로 저장된 주문이라 그대로 담을 수 없어요. 새로 골라주세요.');
        goMode('order'); goStep(savedInfo ? 3 : 1);
      }
      return;
    }
    if (skippedBanchan) alert('이유식만 담았어요. 반찬 세트는 수요일 메뉴에서 따로 골라주세요.');
    setDateOrders([{ id: uid(), delivery_date: '', sets }]); // 날짜는 다시 골라야 함
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
    setRuleError(null); // 내용을 고치는 순간 이전 경고는 치운다
    setDateOrders(prev => prev.map(d => d.id === id ? fn(d) : d));
  }
  function updSet(dateId: string, setId: string, fn: (s: OrderSet) => OrderSet) {
    updDate(dateId, d => ({ ...d, sets: d.sets.map(s => s.id === setId ? fn(s) : s) }));
  }

  // ── 완성된 세트만 필터 (이유식=단계+용량+수량 / 반찬=수량) ──────
  function completeSets(d: DateOrder) {
    return d.sets.filter(isFilledSet);
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
  // 수요일(반찬 세트)은 서버(api/orders)에서도 최소수량 규칙을 예외 처리함 — 여기서도 똑같이 예외 처리해야
  // 반찬 1~2세트만 주문하려는 고객이 "최소 3팩" 경고에 막히지 않는다.
  function isWedDate(date: string): boolean {
    return date.length === 10 && new Date(date + 'T00:00:00Z').getUTCDay() === 3;
  }
  // 한우 비율 — 한우 원가가 비싸서 한우만 담는 주문은 받지 않는다.
  // 날짜(1회분) 단위로 본다 — 최소 팩수와 같은 단위라 손님에게 설명하기도 쉽다.
  function hanwooOn(d: DateOrder) {
    let hanwoo = 0, others = 0;
    for (const s of completeSets(d)) {
      if (isBanchanSet(s)) continue;
      for (const m of MENU_TYPES) {
        const q = s.menus[m] || 0;
        if (m === '한우') hanwoo += q; else others += q;
      }
    }
    return { hanwoo, others };
  }
  // 한우 규칙을 어긴 첫 날짜 (없으면 null).
  // 메뉴보기 화면에서 만든 주문은 아직 state에 없으므로 목록을 직접 넘길 수 있게 인자를 받는다.
  function hanwooViolation(list: DateOrder[] = dateOrders): { date: string; hanwoo: number; others: number; need: number } | null {
    for (const d of list) {
      if (completeSets(d).length === 0) continue;
      const { hanwoo, others } = hanwooOn(d);
      if (!hanwooAllowed(hanwoo, others)) {
        return { date: d.delivery_date, hanwoo, others, need: othersNeededForHanwoo(hanwoo, others) };
      }
    }
    return null;
  }

  // 규칙 위반 메시지 — 담는 중엔 띄우지 않고, 그날 주문을 정리하는 버튼을 누를 때만 보여준다.
  // (한우를 먼저 누르는 게 자연스러운데 담자마자 경고가 뜨면 잘못 담은 것처럼 보임)
  const [ruleError, setRuleError] = useState<string | null>(null);

  // 정리 버튼(주문 확인 · 다른 날짜 추가)에서 부르는 검사. 통과하면 true, 아니면 메시지를 띄우고 false.
  function checkRules(): boolean {
    const hv = hanwooViolation();
    if (hv) {
      const day = hv.date ? hv.date.slice(5) + ' ' : '';
      setRuleError(
        `${day}한우 ${hv.hanwoo}팩 · 나머지 ${hv.others}팩 — 한우는 나머지 메뉴의 ${HANWOO_MAX_RATIO}배까지만 담을 수 있어요. 닭이나 기타를 ${hv.need}팩 더 담아주세요.`
      );
      return false;
    }
    if (!isPickup) {
      const short = shortForDelivery();
      if (short.length > 0) {
        setRuleError(
          `${short.map(x => `${x.label} ${x.qty}팩`).join(' / ')} — 배송은 ${MIN_ORDER_QTY}팩부터예요. 더 담거나 아래에서 픽업을 선택해주세요.`
        );
        return false;
      }
    }
    setRuleError(null);
    return true;
  }

  // 배송 최소 팩수를 못 채운 곳이 있는지 — 픽업이면 이 규칙을 타지 않는다
  function shortForDelivery(): { label: string; qty: number }[] {
    if (combinedDelivery) {
      return Object.entries(groupQtys())
        .filter(([key, q]) => !isWedDate(key) && q < MIN_ORDER_QTY)
        .map(([key, q]) => ({ label: key === 'A' ? '월·화 합산' : key === 'B' ? '목·금 합산' : key, qty: q }));
    }
    return dateOrders
      .filter(d => completeSets(d).length > 0 && !isWedDate(d.delivery_date) && dateQty(d) < MIN_ORDER_QTY)
      .map(d => ({ label: d.delivery_date || '선택한 날짜', qty: dateQty(d) }));
  }

  // 버튼을 눌러볼 수 있는 상태인지 — 날짜·팩수를 아직 안 고른 경우만 막는다.
  // 한우 비율·최소 팩수 위반은 여기서 막지 않고 checkRules()가 눌렀을 때 이유를 알려준다
  // (버튼이 그냥 잠겨 있으면 왜 안 되는지 알 방법이 없음).
  function isStep3Ready(): boolean {
    if (dateOrders.some(d => !d.delivery_date)) return false;
    if (dateOrders.some(d => completeSets(d).length === 0)) return false;
    return true;
  }

  // ── 제출 ──────────────────────────────────────────────────────
  async function submit() {
    setSubmitting(true);
    setServerError(null);

    const totalQty = dateOrders.reduce((sum, d) => sum + dateQty(d), 0);
    const totalPrice = dateOrders.reduce((sum, d) => sum + datePrice(d, tier), 0);
    // 주문 행의 delivery_date는 관리자 목록 정렬·엑셀의 기준이 되는데, 사용자가 날짜를 추가한
    // 순서(dateOrders[0])를 그대로 쓰면 가장 이른 날이 아닐 수 있어 목록이 뒤죽박죽 보였음.
    const firstDate = [...dateOrders.map(d => d.delivery_date).filter(Boolean)].sort()[0] || dateOrders[0].delivery_date;

    // 반찬 세트(volume=0)도 반드시 포함시켜야 함 — 예전엔 `s.volume` 조건에 걸려 빠지는 바람에
    // 서버가 받는 items에 반찬이 아예 없어서 총액 0원 → "가격 계산 오류"로 주문이 거부됐음.
    const itemsPayload = dateOrders.map(d => ({
      delivery_date: d.delivery_date,
      sets: d.sets.filter(isFilledSet).map(s => ({
        stage: s.stage, volume: s.volume,
        price_per: isBanchanSet(s) ? getBanchanPrice(tier) : getPrice(s.stage!, s.volume!, tier),
        simple: !!s._simpleQty,
        menus: s._simpleQty ? [] : MENU_TYPES.filter(m => s.menus[m] > 0).map(m => ({ menu: m, qty: s.menus[m] })),
        qty: setQtyTotal(s),
        subtotal: setPrice(s, tier)
      })),
      date_qty: dateQty(d),
      date_price: datePrice(d, tier)
    }));

    try {
      const r = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baby_name: babyName.trim(), months: parseInt(months),
          customer_phone: phone.replace(/[^\d]/g, ''),
          address: address.trim(), address_detail: addressDetail.trim(), door_password: doorPw.trim(),
          customer_request: customerRequest.trim(),
          stage: dateOrders.length === 1 && dateOrders[0].sets.length === 1 ? dateOrders[0].sets[0].stage : 'mixed',
          volume: dateOrders.length === 1 && dateOrders[0].sets.length === 1 ? dateOrders[0].sets[0].volume : null,
          items: itemsPayload,
          total_qty: totalQty, total_price: totalPrice,
          delivery_date: firstDate, order_type: '일반',
          allergies: allergies.map(k => allergenByKey(k)?.label).filter(Boolean),
          use_points: usePoints,
          postal_code: postalCode,
          zone_group: zoneGroup,
          // 지역 확인이 안 된 경우 '당일배송'으로 잡으면 실제로 당일 배송이 안 되는 지역인데도
          // 당일배송으로 접수돼버림 — 확인 실패 시엔 보수적으로 택배 익일배송으로 접수한다(가격 동일).
          delivery_method: deliveryKind || '택배익일배송',
          receive_method: isPickup ? '픽업' : '배송',
          referrer_phone: referrerPhone.replace(/\D/g, ''),
          referrer_code: (() => { try { return localStorage.getItem(REF_CODE_KEY) || ''; } catch { return ''; } })(),
          acquisition_source: (() => { try { return localStorage.getItem(ACQ_SOURCE_KEY) || ''; } catch { return ''; } })(),
        })
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '저장 실패');
      const firstSet = dateOrders[0]?.sets[0];
      // 이번에 쓴 주소를 주소록에 반영 — 새 주소면 추가되고, 기존 주소면 갱신만 된다.
      // (기본 배송지는 손님이 직접 지정하므로 여기서 임의로 바꾸지 않음)
      rememberAddress();
      doSave({
        babyName: babyName.trim(), months, phone: phone.replace(/[^\d]/g,''),
        address: address.trim(), addressDetail: addressDetail.trim(), doorPw: doorPw.trim(),
        lastStage: firstSet?.stage ?? undefined,
        lastVolume: firstSet?.volume ?? undefined,
        allergies,
        postalCode, zoneGroup, deliveryKind
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
      setWelcomeBonus(d.welcome_bonus || 0);
      setReferralBonusEarned(d.referral_bonus || 0);
      clearDraft(); // 주문이 접수됐으니 담아둔 임시 내용은 지움
      setCompletedId(d.id);
      setStep(5);
    } catch (e: any) { setServerError(e.message); }
    finally { setSubmitting(false); }
  }

  // ── 서비스 소개 화면 (첫 방문자 전용) ───────────────────────────
  if (mode === 'intro') {
    const enter = () => { markIntroSeen(); goMode('home'); };
    return (
      <Wrap>
        <div className="text-center mb-6 pt-6">
          <div className="text-4xl mb-2">🍱</div>
          <div className="text-xl font-bold text-stone-900 mb-1">{STORE_NAME}</div>
          <div className="text-sm text-stone-500">우리 아기 첫 이유식, 신선하게 집까지</div>
        </div>

        <div className="bg-stone-800 text-white rounded-2xl p-4 mb-4">
          <div className="text-sm font-bold mb-1">메뉴는 하루 3가지뿐이에요</div>
          <div className="text-xs text-stone-300 leading-relaxed">대신 그 3가지를 매일 소량으로, 대량생산 없이 진짜 신선하게 조리해요. 많은 종류보다 확실한 신선함을 택했어요.</div>
        </div>

        <div className="space-y-2.5 mb-6">
          <div className="bg-white border border-amber-100 rounded-2xl p-4 flex items-start gap-3">
            <span className="text-2xl">🥕</span>
            <div>
              <div className="text-sm font-bold text-stone-900">주문 즉시 신선 조리</div>
              <div className="text-xs text-stone-500 mt-0.5">냉동 대량생산이 아니라 그때그때 조리해서 배송해요</div>
            </div>
          </div>
          <div className="bg-white border border-amber-100 rounded-2xl p-4 flex items-start gap-3">
            <span className="text-2xl">🌱</span>
            <div>
              <div className="text-sm font-bold text-stone-900">단계별 맞춤 구성</div>
              <div className="text-xs text-stone-500 mt-0.5">중기 1·2단계, 후기, 완료기 — 개월수에 맞는 용량·메뉴로</div>
            </div>
          </div>
          <div className="bg-white border border-amber-100 rounded-2xl p-4 flex items-start gap-3">
            <span className="text-2xl">🚫</span>
            <div>
              <div className="text-sm font-bold text-stone-900">알레르기 메뉴 자동 차단</div>
              <div className="text-xs text-stone-500 mt-0.5">등록해두신 재료가 들어간 메뉴는 주문 자체가 막혀요. 재료만 빼고 조리해드리는 건 어려워서, 아예 선택되지 않게 해뒀어요 (최종 확인은 보호자님이 함께 해주세요)</div>
            </div>
          </div>
          <div className="bg-white border border-amber-100 rounded-2xl p-4 flex items-start gap-3">
            <span className="text-2xl">🚗</span>
            <div>
              <div className="text-sm font-bold text-stone-900">지역별 당일·직배송</div>
              <div className="text-xs text-stone-500 mt-0.5">강서·양천은 직배송, 그 외 지역도 당일배송·택배 익일배송 지원</div>
            </div>
          </div>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center mb-6">
          <div className="text-xs text-amber-700 mb-1">1팩</div>
          <div className="text-2xl font-black text-amber-800">5,000원부터</div>
          <div className="text-[11px] text-amber-600 mt-1">최소 주문 3팩 · 지역에 따라 배송비 일부 포함될 수 있어요</div>
        </div>

        <button onClick={enter}
          className="w-full py-4 bg-amber-500 text-white font-bold rounded-2xl shadow-sm active:bg-amber-600 transition mb-2">
          메뉴 보고 시작하기
        </button>
        <button onClick={enter} className="w-full py-2 text-xs text-stone-400 underline underline-offset-2">
          이미 이용해봤어요, 바로 시작할게요
        </button>
      </Wrap>
    );
  }

  // ── 홈 화면 ─────────────────────────────────────────────────────
  if (mode === 'home') {
    const isReturning = !!(savedInfo?.babyName && savedInfo?.phone); // 주문 이력 있는 재방문 고객인지

    // 처음 오는 손님(주문 이력 없음)은 복잡한 재방문자용 기능 없이 주문 중심으로 단순하게
    if (!isReturning) {
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

          {/* 후기 — 첫 주문 전 신뢰 신호 */}
          <div className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-bold text-stone-700 flex items-center gap-1.5">
                이용 후기
                {reviewSummary.count > 0 && (
                  <span className="text-amber-600 font-bold">⭐ {reviewSummary.avg} <span className="text-stone-400 font-normal">({reviewSummary.count}개)</span></span>
                )}
              </span>
            </div>
            {reviews.length === 0 ? (
              <div className="bg-white border border-stone-100 rounded-xl px-4 py-5 text-center text-xs text-stone-400">
                아직 후기가 없어요. 첫 후기의 주인공이 되어보세요! 🍱
              </div>
            ) : (
              <div className="space-y-2">
                {reviews.slice(0, 3).map(rv => (
                  <div key={rv.id} className="bg-white border border-stone-100 rounded-xl px-4 py-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold text-stone-700">{rv.baby_name} 부모님</span>
                      <span className="text-amber-500 text-xs">{'★'.repeat(rv.rating)}{'☆'.repeat(5 - rv.rating)}</span>
                    </div>
                    <p className="text-xs text-stone-600 leading-relaxed line-clamp-3">{rv.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 알레르기는 미리 등록해두면 편해서 첫방문자에게도 유지 */}
          <div className="mt-3">
            <AllergyEditor allergies={allergies} toggle={toggleAllergy} open={allergyOpen} setOpen={setAllergyOpen} />
          </div>
          <AdminLink />
        </Wrap>
      );
    }

    return (
      <Wrap>
        <div className="text-center mb-8 pt-4">
          <div className="text-3xl mb-2">🍱</div>
          <div className="text-xl font-bold text-stone-900 mb-1">까꿍 디미방</div>
          <div className="text-sm text-stone-500">신선한 이유식을 집까지</div>
        </div>

        {/* 담다 만 주문 이어하기 — 전화 받다가 앱을 벗어나도 고른 게 남아 있게 */}
        {draftFound && (
          <div className="mb-3 bg-white border-2 border-amber-300 rounded-xl px-4 py-3">
            <div className="text-sm font-bold text-stone-800 mb-0.5">담아두신 주문이 있어요</div>
            <div className="text-xs text-stone-500 mb-2">
              {[...new Set(draftFound.map((d: any) => d.delivery_date).filter(Boolean))].join(', ')}
              {' · '}
              {draftFound.reduce((s: number, d: any) =>
                s + (d.sets || []).reduce((a: number, x: any) => a + (x._simpleQty ?? Object.values(x.menus || {}).reduce((p: number, q: any) => p + (q || 0), 0)), 0), 0)}팩
            </div>
            <div className="flex gap-2">
              <button onClick={() => {
                  // 어제 담아둔 걸 오늘 이어하면 그 날짜는 이미 마감이라 마지막 제출에서야 거부당함 —
                  // 지난 날짜는 비워서 다시 고르게 한다.
                  const t = kstToday();
                  setDateOrders((draftFound as any[]).map(d => d.delivery_date > t ? d : { ...d, delivery_date: '' }));
                  setDraftFound(null); goMode('order'); goStep(savedInfo ? 3 : 1);
                }}
                className="flex-1 py-2 bg-amber-500 text-white rounded-lg text-xs font-bold">이어서 주문하기</button>
              <button onClick={() => { clearDraft(); setDraftFound(null); }}
                className="px-3 py-2 bg-white border border-stone-200 text-stone-500 rounded-lg text-xs font-bold">지우기</button>
            </div>
          </div>
        )}

        {/* 배송상태 알림 배너 */}
        {statusAlerts.length > 0 && (
          <div className="mb-3 space-y-2">
            {statusAlerts.map(a => {
              const info = a.status === '배송완료'
                ? { emoji: '✅', text: '배송이 완료됐어요!', cls: 'bg-emerald-50 border-emerald-200 text-emerald-800' }
                : a.status === '배송중'
                  ? { emoji: '🚚', text: '배송을 출발했어요! 곧 도착합니다', cls: 'bg-violet-50 border-violet-200 text-violet-800' }
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
        {(() => {
          const note = stageTransitionNote(parseInt(savedInfo!.months || '0'), savedInfo!.lastStage);
          if (!note) return null;
          return (
            <div className="mb-3 bg-sky-50 border border-sky-200 rounded-xl px-4 py-3 text-xs text-sky-800 leading-relaxed">
              🌱 {note}
            </div>
          );
        })()}

        <div className="flex flex-col gap-3">
          {/* 주요 동작 */}
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
          {/* 부가 기능 — 3열 컴팩트 */}
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => goMode('calendar')}
              className="py-3 bg-white border border-violet-200 rounded-xl text-violet-800 font-bold text-xs shadow-sm hover:border-violet-400 transition"
            >
              <div className="text-lg mb-0.5">📅</div>
              한 달 식단표
            </button>
            <button
              onClick={() => { goMode('mypage'); const p = savedInfo?.phone || ''; const nm = savedInfo?.babyName || ''; if (p) setMyPhone(p); if (nm) setMyName(nm); if (p && nm) fetchMyOrders(p, nm); }}
              className="py-3 bg-white border border-stone-200 rounded-xl text-stone-700 font-bold text-xs shadow-sm hover:border-stone-400 transition"
            >
              <div className="text-lg mb-0.5">📦</div>
              내 주문 조회
            </button>
            <button
              onClick={() => { goMode('album'); refreshAlbum(); }}
              className="py-3 bg-white border border-pink-200 rounded-xl text-pink-800 font-bold text-xs shadow-sm hover:border-pink-400 transition"
            >
              <div className="text-lg mb-0.5">📸</div>
              성장앨범
            </button>
          </div>

          {/* 정기배송 — 신청 화면(내 주문 조회 안)이 눈에 잘 안 띄어서 홈에 바로 노출 */}
          <button
            onClick={() => {
              const p = savedInfo?.phone || ''; const nm = savedInfo?.babyName || '';
              if (!p || !nm) { alert('정기배송은 먼저 주문을 한 번 하신 뒤 신청하실 수 있어요!'); goMode('menu'); return; }
              goMode('mypage'); setMyPhone(p); setMyName(nm); fetchMyOrders(p, nm);
            }}
            className="w-full py-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 font-bold text-xs shadow-sm flex items-center justify-center gap-1.5"
          >
            🔁 정기배송 신청 — 매번 안 시켜도 자동으로 배송돼요
          </button>

          {/* 친구초대 */}
          <button onClick={() => shareApp(savedInfo?.phone)}
            className="w-full py-3 bg-white border border-amber-200 rounded-xl text-amber-800 font-bold text-xs shadow-sm flex items-center justify-center gap-1.5">
            📣 친구 초대하고 3,000P 받기
          </button>
        </div>

        {/* 후기 */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-bold text-stone-700 flex items-center gap-1.5">
              이용 후기
              {reviewSummary.count > 0 && (
                <span className="text-amber-600 font-bold">⭐ {reviewSummary.avg} <span className="text-stone-400 font-normal">({reviewSummary.count}개)</span></span>
              )}
            </span>
            <button onClick={() => goMode('review')} className="text-xs text-amber-700 font-bold">후기 남기고 1,000P →</button>
          </div>
          {reviews.length === 0 ? (
            <div className="bg-white border border-stone-100 rounded-xl px-4 py-5 text-center text-xs text-stone-400">
              아직 후기가 없어요. 첫 후기의 주인공이 되어보세요! 🍱
            </div>
          ) : (
            <div className="space-y-2">
              {reviews.slice(0, 3).map(rv => (
                <div key={rv.id} className="bg-white border border-stone-100 rounded-xl px-4 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-stone-700">{rv.baby_name} 부모님</span>
                    <span className="text-amber-500 text-xs">{'★'.repeat(rv.rating)}{'☆'.repeat(5 - rv.rating)}</span>
                  </div>
                  <p className="text-xs text-stone-600 leading-relaxed line-clamp-3">{rv.content}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-3 space-y-3">
          <AllergyEditor allergies={allergies} toggle={toggleAllergy} open={allergyOpen} setOpen={setAllergyOpen} />
          <FoodDiary diary={diary} update={updateFood} open={diaryOpen} setOpen={setDiaryOpen}
            symptoms={symptoms} onLog={logSymptom} onDel={delSymptom} />
        </div>
        <AdminLink />
      </Wrap>
    );
  }

  // ── 후기 작성 화면 ──────────────────────────────────────────────
  if (mode === 'review') {
    if (reviewDone !== null) {
      return (
        <Wrap>
          <div className="bg-white rounded-2xl p-7 shadow-sm border border-amber-100 text-center">
            <div className="text-5xl mb-4">🙏</div>
            <h1 className="text-xl font-bold text-stone-900 mb-2">후기 감사해요!</h1>
            {reviewDone > 0 ? (
              <p className="text-sm text-violet-600 font-bold mb-5">{reviewDone.toLocaleString()}P 적립됐어요</p>
            ) : (
              <p className="text-sm text-stone-500 mb-5">이미 첫 후기 포인트를 받으셨어요. 소중한 후기 감사합니다!</p>
            )}
            <button onClick={() => goMode('home')} className="w-full py-3 bg-amber-500 text-white font-bold text-sm rounded-xl">처음으로</button>
          </div>
        </Wrap>
      );
    }
    return (
      <Wrap>
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => goMode('home')} className="text-stone-400 text-lg">←</button>
          <h1 className="text-lg font-bold text-stone-900 flex-1">후기 남기기</h1>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5 text-xs text-amber-800 mb-4 leading-relaxed">
          💡 주문 이력이 있는 연락처만 작성할 수 있어요. 첫 후기 작성 시 1,000P를 드려요!
        </div>
        <Field label="아기 이름"><input value={reviewBabyName} onChange={e=>setReviewBabyName(e.target.value)} maxLength={20} placeholder="아기 이름" className={iCls}/></Field>
        <Field label="연락처"><input value={reviewPhone} onChange={e=>setReviewPhone(formatPhone(e.target.value))} inputMode="numeric" maxLength={13} placeholder="주문한 연락처" className={iCls}/></Field>
        <Field label="별점">
          <div className="flex gap-1">
            {[1,2,3,4,5].map(n => (
              <button key={n} type="button" onClick={() => setReviewRating(n)} className="text-2xl leading-none">
                {n <= reviewRating ? '★' : '☆'}
              </button>
            ))}
          </div>
        </Field>
        <Field label="후기 내용">
          <textarea value={reviewContent} onChange={e=>setReviewContent(e.target.value)} maxLength={500} rows={4}
            placeholder="이유식은 어땠나요? 배송, 맛, 아기 반응 등 자유롭게 남겨주세요"
            className={iCls} />
        </Field>
        {reviewError && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{reviewError}</div>}
        <button onClick={submitReview} disabled={reviewSubmitting}
          className="w-full py-3.5 bg-amber-500 text-white font-bold text-sm rounded-xl disabled:bg-stone-200">
          {reviewSubmitting ? '등록 중…' : '후기 등록하기'}
        </button>
      </Wrap>
    );
  }

  // ── 메뉴보기 화면 ─────────────────────────────────────────────
  if (mode === 'menu') {
    // 날짜별 독립 helpers
    const EMPTY_SEL: MenuSel2 = { stage: null, volume: null, byCombo: {} };
    const menuSelOf = (date: string): MenuSel2 => menuSels[date] ?? EMPTY_SEL;
    const updMenuSel = (date: string, fn: (s: MenuSel2) => MenuSel2) =>
      setMenuSels(prev => ({ ...prev, [date]: fn(prev[date] ?? EMPTY_SEL) }));

    // 지금 편집 중인 조합의 수량 (단계·용량을 아직 안 고르면 빈 값)
    const curQtys = (sel: MenuSel2): Record<MenuType, number> =>
      sel.stage && sel.volume ? (sel.byCombo[comboKey(sel.stage, sel.volume)] ?? emptyMenus()) : emptyMenus();
    // 그 날짜에 담긴 조합 전부 (수량 0인 건 제외)
    const combosOf = (sel: MenuSel2) =>
      Object.entries(sel.byCombo)
        .filter(([, q]) => comboQty(q) > 0)
        .map(([key, q]) => ({ key, ...parseCombo(key), qtys: q, qty: comboQty(q) }))
        .sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || a.volume - b.volume);
    const dayQtyOf = (sel: MenuSel2) => combosOf(sel).reduce((a, c) => a + c.qty, 0);

    const totalMenuQty = Object.values(menuSels).reduce((s, sel) => s + dayQtyOf(sel), 0)
      + Object.values(banchanQtys).reduce((a, b) => a + b, 0);
    // 정책: 메뉴보기(주소 전)에서는 가격 미표시

    const goOrderFromMenu = () => {
      // 한 날짜에 담긴 조합 전부를 세트로 만든다 (중기1 240 + 중기1 310처럼 여러 개 가능)
      const yushikOrders: DateOrder[] = Object.entries(menuSels)
        .map(([date, sel]) => ({ date, combos: combosOf(sel) }))
        .filter(({ combos }) => combos.length > 0)
        .map(({ date, combos }) => ({
          id: uid(), delivery_date: date,
          sets: combos.map(c => ({ id: uid(), stage: c.stage, volume: c.volume, menus: c.qtys })),
        }));
      const banchanOrders: DateOrder[] = Object.entries(banchanQtys)
        .filter(([, qty]) => qty > 0)
        .map(([date, qty]) => ({
          id: uid(), delivery_date: date,
          sets: [{ id: uid(), stage: '반찬세트' as any, volume: 0 as any, menus: emptyMenus(), _simpleQty: qty }]
        }));
      const allOrders = [...yushikOrders, ...banchanOrders];
      if (allOrders.length === 0) return;
      // 여기서 안 잡으면 주문 확인 화면으로 바로 넘어가버려서, 마지막 제출에서야 거부당한다
      const hv = hanwooViolation(allOrders);
      if (hv) {
        alert(`${hv.date ? hv.date.slice(5) + ' ' : ''}한우 ${hv.hanwoo}팩 · 나머지 ${hv.others}팩\n\n한우는 나머지 메뉴의 ${HANWOO_MAX_RATIO}배까지만 담을 수 있어요.\n닭이나 기타를 ${hv.need}팩 더 담아주세요.`);
        return;
      }
      setDateOrders(allOrders);
      goMode('order');
      // 배송 최소 팩수를 못 채웠으면 확인 화면으로 건너뛰지 말고 담기 화면에서 픽업을 고르게 한다
      const short = allOrders.some(d =>
        !isWedDate(d.delivery_date) && d.sets.filter(isFilledSet).reduce((a, s) => a + setQtyTotal(s), 0) < MIN_ORDER_QTY);
      goStep(!savedInfo ? 1 : short ? 3 : 4);
    };

    return (
      <Wrap>
        {/* 헤더 */}
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => goMode('home')} className="text-stone-400 text-lg">←</button>
          <h1 className="text-lg font-bold text-stone-900 flex-1">메뉴 보기 · 주문</h1>
          <div className="flex gap-1">
            {/* 예전엔 이유식 선택(menuSels)만 지우고 반찬 수량(banchanQtys)은 안 지워서,
                주를 바꾸면 지난주 날짜의 반찬이 그대로 남아 다음주 주문에 섞여 들어갔음 */}
            {[0,1].map(w => (
              <button key={w} onClick={() => { setWeekOffset(w); setExpandedDate(null); setMenuSels({}); setBanchanQtys({}); }}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition ${weekOffset===w?'bg-amber-500 border-amber-500 text-white':'bg-white border-stone-200 text-stone-500'}`}>
                {w===0?'이번주':'다음주'}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-stone-500 mb-3">날짜 탭 → 단계·용량 선택 → 메뉴별 수량 · 날짜마다 다른 단계·용량 가능</p>
        <div className="mb-3 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5 text-xs text-amber-800">
          💡 배송지 입력 후 가격이 표시돼요 (지역에 따라 금액이 달라져요)
        </div>

        {menuLoading ? (
          // 불러오는 동안 아무것도 없으면 "메뉴가 없다"고 오해함 — 자리를 잡아둔다
          <div className="space-y-2">
            {[0, 1, 2].map(i => (
              <div key={i} className="bg-white border border-stone-100 rounded-xl px-4 py-5 animate-pulse">
                <div className="h-3.5 w-24 bg-stone-200 rounded mb-2.5" />
                <div className="h-3 w-full bg-stone-100 rounded mb-1.5" />
                <div className="h-3 w-2/3 bg-stone-100 rounded" />
              </div>
            ))}
          </div>
        ) : dayMenus.length === 0 ? (
          <div className="text-center py-10 text-stone-400 text-sm">이번 주 메뉴가 아직 등록되지 않았어요</div>
        ) : (
          <div className="space-y-2">
            {dayMenus.map(day => {
              const isBanchan = !!day.banchan;
              const isOpen = expandedDate === day.date;
              const sel = menuSelOf(day.date);
              const bQty = banchanQtys[day.date] ?? 0;
              const combos = combosOf(sel);
              const dayQty = isBanchan ? bQty : dayQtyOf(sel);
              const selVolOpts = sel.stage ? STAGE_OPTIONS[sel.stage] : [];
              const qtysNow = curQtys(sel);
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
                      {/* 담은 조합을 접힌 상태에서도 알 수 있게 — 여러 개일 수 있음 */}
                      {!isBanchan && combos.length > 0 && (
                        <span className="text-[10px] text-stone-500">
                          {combos.map(c => `${c.stage.replace('중기1단계','중1').replace('중기2단계','중2').replace('완료기','완료')} ${c.volume}g`).join(' + ')}
                        </span>
                      )}
                      {dayQty > 0 && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-bold text-white ${isBanchan ? 'bg-emerald-500' : 'bg-amber-500'}`}>
                          {isBanchan ? `${dayQty}세트` : `${dayQty}팩`}
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
                          <div className="text-xs text-stone-500 font-medium">🍱 반찬 세트</div>
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
                          {bQty > 0 && <div className="text-xs text-emerald-700 font-bold text-right">{bQty}세트</div>}
                        </div>
                      )}

                      {/* 담아둔 조합 목록 — 단계·용량을 바꿔도 사라지지 않는다는 걸 눈으로 확인할 수 있게 */}
                      {!isBanchan && combos.length > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-2.5 space-y-1.5">
                          <div className="text-[11px] font-bold text-amber-800">담은 것 ({dayQty}팩)</div>
                          {combos.map(c => {
                            const editing = sel.stage === c.stage && sel.volume === c.volume;
                            return (
                              <div key={c.key} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 border ${editing ? 'bg-white border-amber-400' : 'bg-white/70 border-transparent'}`}>
                                <button onClick={() => updMenuSel(day.date, s => ({ ...s, stage: c.stage, volume: c.volume }))}
                                  className="flex-1 text-left">
                                  <div className="text-xs font-bold text-stone-800">{c.stage} {c.volume}g · {c.qty}팩</div>
                                  <div className="text-[11px] text-stone-500">
                                    {MENU_TYPES.filter(m => c.qtys[m] > 0).map(m => `${menuLabel(m)} ${c.qtys[m]}`).join(' · ')}
                                  </div>
                                </button>
                                <button onClick={() => updMenuSel(day.date, s => {
                                    const next = { ...s.byCombo }; delete next[c.key];
                                    return { ...s, byCombo: next };
                                  })}
                                  aria-label="이 조합 지우기"
                                  className="w-7 h-7 flex items-center justify-center text-stone-400 border border-stone-200 rounded-lg bg-white">×</button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* 이유식 단계 선택 — 바꿔도 담아둔 수량은 유지된다(조합별로 따로 보관) */}
                      {!isBanchan && <div>
                        <div className="text-[11px] text-stone-500 mb-1.5">
                          단계 {combos.length > 0 && <span className="text-amber-700 font-bold">— 다른 단계·용량도 이어서 담을 수 있어요</span>}
                        </div>
                        <div className="grid grid-cols-4 gap-1.5">
                          {STAGES.map(st => {
                            const has = combos.some(c => c.stage === st);
                            return (
                              <button key={st}
                                onClick={() => updMenuSel(day.date, s => ({ ...s, stage: st, volume: null }))}
                                className={`relative py-2 rounded-lg text-xs font-bold border transition ${sel.stage===st?'bg-amber-500 border-amber-500 text-white':has?'bg-amber-50 border-amber-300 text-amber-800':'bg-white border-amber-100 text-stone-700'}`}>
                                {st.replace('중기1단계','중1').replace('중기2단계','중2').replace('후기','후기').replace('완료기','완료')}
                                {has && sel.stage!==st && <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-500 rounded-full" />}
                              </button>
                            );
                          })}
                        </div>
                      </div>}

                      {/* 이유식 용량 선택 */}
                      {!isBanchan && sel.stage && (
                        <div>
                          <div className="text-[11px] text-stone-500 mb-1.5">용량</div>
                          <div className="flex gap-2">
                            {selVolOpts.map(opt => {
                              const q = comboQty(sel.byCombo[comboKey(sel.stage!, opt.volume)]);
                              return (
                                <button key={opt.volume}
                                  onClick={() => updMenuSel(day.date, s => ({ ...s, volume: opt.volume }))}
                                  className={`flex-1 py-2 rounded-xl border text-xs font-bold transition ${sel.volume===opt.volume?'bg-amber-500 border-amber-500 text-white':q>0?'bg-amber-50 border-amber-300 text-amber-800':'bg-white border-amber-100 text-stone-700'}`}>
                                  {opt.volume}g{q > 0 && <span className="ml-1">· {q}팩</span>}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* 이유식 메뉴별 수량 */}
                      {/* ⚠️ 알레르기 재료는 조리 과정에서 빼드릴 수 없음 — 예전엔 경고만 띄우고
                          주문은 되게 해서 "빼주겠지"라는 오해를 줄 수 있었음. 해당 메뉴는 아예 못 고르게 막는다. */}
                      {!isBanchan && sel.volume && day.menus.map((m, i) => {
                        const hits = matchAllergens(m.ingredients, allergies);
                        const blocked = hits.length > 0;
                        return (
                        <div key={i} className={`flex items-center gap-2 ${blocked ? 'opacity-70' : ''}`}>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={`flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                                m.type==='한우'?'bg-amber-100 text-amber-800':m.type==='닭'?'bg-emerald-100 text-emerald-800':'bg-violet-100 text-violet-800'}`}>
                                {menuLabel(m.type)}
                              </span>
                              <span className="text-sm font-medium text-stone-900 truncate">{m.name}</span>
                              {reactions[m.name] === 'like' && <span className="flex-shrink-0 text-[10px]">👍</span>}
                            </div>
                            <div className="text-[11px] text-stone-500 mt-0.5 pl-0.5 truncate">{m.ingredients}</div>
                            {blocked ? (
                              <div className="mt-1 text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1 leading-relaxed">
                                🚫 {hits.map(h => h.label).join(', ')} 들어있어 주문할 수 없어요
                                <div className="font-normal text-rose-600 mt-0.5">재료를 빼고 조리해드릴 수는 없어서 막아뒀어요. 알레르기 등록을 바꾸시려면 홈에서 수정해주세요.</div>
                              </div>
                            ) : (
                              <ReactionCtrl name={m.name} current={reactions[m.name]} onRate={rateMenu} />
                            )}
                          </div>
                          {blocked ? (
                            <span className="text-[11px] font-bold text-rose-600 whitespace-nowrap px-2">주문 불가</span>
                          ) : !(MENU_TYPES as readonly string[]).includes(m.type) ? (
                            // 주방이 새 메뉴 타입을 쓰기 시작하면 여기서 막는다 — 담을 수는 있는데
                            // 주문서엔 안 남는(=돈만 받고 조리는 못 하는) 상태가 되는 게 최악이라,
                            // 아예 담기지 않게 하고 전화 주문으로 돌린다.
                            <span className="text-[11px] font-bold text-stone-400 whitespace-nowrap px-2">전화 문의</span>
                          ) : (
                            <QtyCtrl
                              value={qtysNow[m.type as MenuType] ?? 0}
                              onChange={v => updMenuSel(day.date, s => {
                                if (!s.stage || !s.volume) return s;
                                // 지금 고른 조합(단계|용량) 칸에만 기록 — 다른 조합에 담아둔 건 건드리지 않는다
                                const k = comboKey(s.stage, s.volume);
                                const cur = s.byCombo[k] ?? emptyMenus();
                                return { ...s, byCombo: { ...s.byCombo, [k]: { ...cur, [m.type as MenuType]: Math.max(0, Math.min(10, v)) } } };
                              })}
                            />
                          )}
                        </div>
                        );
                      })}
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
          <div className="fixed bottom-0 left-0 right-0 px-4 pt-3 safe-bottom bg-gradient-to-t from-amber-50 via-amber-50/95 to-transparent">
            <button onClick={goOrderFromMenu}
              className="w-full max-w-md mx-auto block py-4 bg-amber-500 text-white font-bold rounded-2xl shadow-lg shadow-amber-500/25 text-sm">
              {(() => {
                const bTotal = Object.values(banchanQtys).reduce((a,b)=>a+b,0);
                const yTotal = totalMenuQty - bTotal;
                const parts = [];
                if (yTotal > 0) parts.push(`이유식 ${yTotal}팩`);
                if (bTotal > 0) parts.push(`반찬 ${bTotal}세트`);
                return `${parts.join(' · ')} — 배송지 입력하고 주문하기 →`;
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
      '배송중': 'bg-violet-100 text-violet-800',
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
            <input value={myPhone} onChange={e => setMyPhone(formatPhone(e.target.value))} inputMode="numeric" maxLength={13}
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

            {/* 배송상태 웹푸시 알림 */}
            <div className="mb-4">
              {pushStatus === 'ok' ? (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3.5 py-2.5 text-xs text-emerald-700 font-bold text-center">🔔 배송 알림이 켜졌어요</div>
              ) : (
                <button onClick={handleSubscribePush} disabled={pushStatus === 'loading'}
                  className="w-full py-3 bg-white border border-sky-200 rounded-xl text-sky-700 font-bold text-xs shadow-sm disabled:opacity-50">
                  {pushStatus === 'loading' ? '설정 중…' : '🔔 배송상태 바뀔 때 알림 받기'}
                </button>
              )}
              {pushStatus === 'denied' && <p className="text-[10px] text-stone-400 mt-1 text-center">브라우저 알림 권한이 꺼져있어요. 설정에서 허용해주세요.</p>}
              {pushStatus === 'unsupported' && <p className="text-[10px] text-stone-400 mt-1 text-center">이 브라우저는 알림을 지원하지 않아요. (iPhone은 홈 화면에 추가한 뒤 가능해요)</p>}
              {pushStatus === 'error' && <p className="text-[10px] text-stone-400 mt-1 text-center">알림 설정에 실패했어요. 잠시 후 다시 시도해주세요.</p>}
            </div>

            {/* ⑧ 정기배송 신청 */}
            <RegularSetup phone={myPhone.replace(/\D/g, '')} babyName={myName.trim()} initial={cust} onSaved={() => fetchMyOrders(myPhone)} />

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
                    <div className="flex gap-2 mt-2">
                      {o.status !== '취소' && (
                        <button onClick={() => reorderFromHistory(o)}
                          className="flex-1 py-2 text-[11px] font-bold text-amber-700 border border-amber-200 bg-amber-50 rounded-lg">
                          이 구성 그대로 다시 주문
                        </button>
                      )}
                      {o.status === '접수' && (
                        <button onClick={() => cancelMyOrder(o.id)}
                          className="flex-1 py-2 text-[11px] font-bold text-rose-500 border border-rose-200 rounded-lg">
                          이 주문 취소
                        </button>
                      )}
                    </div>
                    {/* 언제까지 취소되는지 몰라 전화로 물어보는 일이 많음 */}
                    {o.status === '접수' && (
                      <p className="text-[10px] text-stone-400 mt-1.5 leading-relaxed">
                        조리 준비가 시작되기 전(상태 ‘접수’)까지만 직접 취소할 수 있어요. 이후에는 연락 주세요.
                      </p>
                    )}
                    {o.status === '준비중' && (
                      <p className="text-[10px] text-stone-400 mt-1.5">이미 조리 준비가 시작돼 앱에서는 취소가 안 돼요. 급하면 연락 주세요.</p>
                    )}
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
            {albumBusy ? '저장 중…' : '📷 사진 추가 (촬영 · 앨범에서 선택)'}
            <input type="file" accept="image/*" className="hidden" disabled={albumBusy}
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
    const totalPrice = dateOrders.reduce((s, d) => s + datePrice(d, tier), 0);
    return (
      <Wrap>
        <div className="bg-white rounded-2xl p-7 shadow-sm border border-amber-100 text-center">
          <div className="text-5xl mb-4">🍱</div>
          <h1 className="text-xl font-bold text-stone-900 mb-2">주문이 접수됐어요!</h1>
          {/* 주문은 항상 "내일 이후" 조리분인데 안내는 "오늘 오후 배송"으로 고정돼 있어서
              실제 배송일과 다른 안내가 나갔음 — 실제 조리일을 그대로 보여준다. */}
          <p className="text-sm text-stone-500 mb-5 leading-relaxed">
            {[...new Set(dateOrders.map(d => d.delivery_date).filter(Boolean))].sort().join(', ')}
            <br />{isPickup ? '픽업(방문수령) — 조리 완료 후 매장에서 받아가실 수 있어요' : '조리 후 당일 오후 12~18시에 배송됩니다'}
          </p>
          <div className="bg-amber-50 rounded-xl px-4 py-3 text-xs text-stone-700 leading-loose text-left mb-4 space-y-2">
            {dateOrders.map(d => (
              <div key={d.id}>
                <div className="font-bold text-amber-700">{d.delivery_date} ({dateQty(d)}팩)</div>
                {/* 반찬 세트는 volume=0이라 `s.volume` 조건에 걸려 완료 화면에서만 안 보였음 */}
                {d.sets.filter(isFilledSet).map(s => (
                  <div key={s.id} className="pl-3">
                    {isBanchanSet(s)
                      ? `반찬 세트 ${setQtyTotal(s)}세트`
                      : `${s.stage} ${s.volume}g — ${s._simpleQty ? `${s._simpleQty}팩` : MENU_TYPES.filter(m=>s.menus[m]>0).map(m=>`${menuLabel(m)} ${s.menus[m]}`).join(' / ')}`}
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
            {/* 배송비가 따로 안 붙어서 "배송비는 얼마냐"고 자주 물어봄 — 단가에 포함돼 있다고 명시 */}
            <div className="border-t border-amber-100 mt-2 pt-2 text-[11px] text-stone-500 font-normal leading-relaxed">
              {isPickup
                ? '픽업이라 배송비가 없어요. 표시된 금액이 전부예요.'
                : tier === '직배송'
                ? '별도 배송비 없어요. 표시된 금액이 전부예요.'
                : `별도 배송비는 없고, 배송비가 팩 단가에 포함돼 있어요 (직배송 지역보다 팩당 ${PACK_SURCHARGE.toLocaleString()}원).`}
            </div>
          </div>
          {(earnedPoints > 0 || usedPoints > 0) && (
            <div className="bg-violet-50 border border-violet-200 rounded-xl px-4 py-2.5 text-sm font-bold text-violet-700 mb-3">
              {usedPoints > 0 && <span>💜 {usedPoints.toLocaleString()}P 사용</span>}
              {usedPoints > 0 && earnedPoints > 0 && <span> · </span>}
              {earnedPoints > 0 && <span>{earnedPoints.toLocaleString()}P 적립됐어요!</span>}
            </div>
          )}
          {referralBonusEarned > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800 mb-3">🎉 추천인 보너스 {referralBonusEarned.toLocaleString()}P 포함! 추천해주신 분께도 같은 포인트가 적립됐어요.</div>
          )}
          {welcomeBonus > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800 mb-3">🎉 첫 주문 웰컴포인트 {welcomeBonus.toLocaleString()}P 포함!</div>
          )}
          <p className="text-[11px] text-stone-400 mb-4">주문번호 {completedId.slice(0,8)}</p>

          {/* 접수 후 "잘 들어갔나 / 바꾸고 싶은데 어디로 말하지"에 답이 없어서 그냥 전화가 옴 */}
          <div className="bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-left mb-4">
            <div className="text-xs font-bold text-stone-700 mb-1">주문을 바꾸거나 물어보고 싶다면</div>
            <p className="text-[11px] text-stone-500 leading-relaxed mb-2">
              조리 준비 전까지는 <span className="font-bold">내 주문내역</span>에서 직접 취소할 수 있어요.
              그 밖의 변경·문의는 아래로 연락 주세요.
            </p>
            <div className="flex gap-2">
              <button onClick={() => { setMyPhone(phone); setMyName(babyName); goMode('mypage'); fetchMyOrders(phone, babyName); }}
                className="flex-1 py-2 bg-white border border-stone-200 rounded-lg text-[11px] font-bold text-stone-700">
                내 주문내역 보기
              </button>
              {STORE_CONTACT && (
                <a href={`tel:${STORE_CONTACT.replace(/\D/g, '')}`}
                  className="flex-1 py-2 bg-white border border-stone-200 rounded-lg text-[11px] font-bold text-stone-700 text-center">
                  📞 {STORE_CONTACT}
                </a>
              )}
            </div>
          </div>

          {/* 친구초대 + 후기유도 (전환율 장치) */}
          <div className="space-y-2 pt-4 border-t border-stone-100">
            <button onClick={() => shareApp(phone.replace(/\D/g, ''))}
              className="w-full py-3 bg-amber-500 text-white font-bold text-sm rounded-xl active:bg-amber-600">
              📣 친구에게 공유하고 3,000P 받기
            </button>
            <button onClick={() => goMode('review')}
              className="w-full py-3 bg-white border border-stone-200 text-stone-700 font-bold text-sm rounded-xl">
              ⭐ 후기 남기고 1,000P 받기
            </button>
            <button onClick={() => goMode('home')} className="w-full py-2 text-xs text-stone-400 underline underline-offset-2">처음으로</button>
          </div>
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
          <Field label="연락처"><input value={phone} onChange={e=>setPhone(formatPhone(e.target.value))} inputMode="numeric" maxLength={13} placeholder="010-0000-0000" className={iCls}/></Field>
          {refCodeCaptured ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3.5 py-2.5 text-xs text-emerald-700 font-bold mb-3">
              ✅ 추천 링크로 들어오셨어요 — 첫 주문 시 두 분 다 3,000P가 자동 적립돼요
            </div>
          ) : (
            <Field label="추천인 연락처 (선택)">
              <input value={referrerPhone} onChange={e=>setReferrerPhone(formatPhone(e.target.value))} inputMode="numeric" maxLength={13} placeholder="010-0000-0000" className={iCls}/>
              <p className="text-[11px] text-stone-400 mt-1">친구·지인 추천으로 오셨다면 입력해주세요. 첫 주문에 한해 두 분 다 3,000P를 드려요!</p>
            </Field>
          )}
          {/* 저장해둔 배송지 목록 — 기본 배송지로 시작하되 이번 주문만 다른 곳으로 고를 수 있음 */}
          {addrBook.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-stone-500 font-semibold mb-1.5">배송지 선택</div>
              <div className="space-y-1.5">
                {addrBook.map(a => {
                  const on = selectedAddrId === a.id;
                  return (
                    <div key={a.id}
                      className={`rounded-xl border px-3 py-2.5 ${on ? 'border-amber-400 bg-amber-50' : 'border-stone-200 bg-white'}`}>
                      <button type="button" onClick={() => pickAddress(a)} className="w-full text-left">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${on ? 'border-amber-500 bg-amber-500' : 'border-stone-300'}`} />
                          <span className="text-xs font-bold text-stone-800">{a.label}</span>
                          {a.isDefault && <span className="text-[10px] bg-amber-500 text-white px-1.5 py-0.5 rounded-full font-bold">기본</span>}
                        </div>
                        <div className="text-sm text-stone-700 pl-5">{a.address}{a.addressDetail ? ' ' + a.addressDetail : ''}</div>
                      </button>
                      <div className="flex gap-2 pl-5 mt-1.5">
                        {!a.isDefault && (
                          <button type="button" onClick={() => setDefaultAddress(a.id)}
                            className="text-[11px] text-amber-700 font-bold">기본으로</button>
                        )}
                        <button type="button" onClick={() => renameAddress(a.id)}
                          className="text-[11px] text-stone-500">이름변경</button>
                        <button type="button" onClick={() => removeAddress(a.id)}
                          className="text-[11px] text-stone-400">삭제</button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button type="button"
                onClick={() => { setSelectedAddrId(null); setAddress(''); setAddressDetail(''); setDoorPw(''); setPostalCode(''); setZoneGroup(null); setDeliveryKind(null); openPostcode(); }}
                className="w-full mt-2 py-2.5 border border-dashed border-amber-300 rounded-xl text-amber-700 text-xs font-bold">
                + 새 배송지 추가
              </button>
            </div>
          )}

          {/* 예전 주문 이력에서 찾은 주소는 "제안"일 뿐 자동으로 채우지 않는다 —
              이사했거나 이번만 다른 곳으로 받는데 자동으로 채우면 예전 집으로 가는 사고가 남 */}
          {knownAddr && !address && (
            <div className="mb-3 bg-emerald-50 border border-emerald-200 rounded-xl px-3.5 py-3">
              <div className="text-xs text-emerald-800 font-bold mb-1">전에 주문하셨던 주소예요</div>
              <div className="text-sm text-stone-700 mb-1">{knownAddr.address}</div>
              <div className="text-[11px] text-stone-500 mb-2">이사하셨거나 이번만 다른 곳으로 받으시면 아래에서 새로 검색해주세요.</div>
              <div className="flex gap-2">
                <button type="button"
                  onClick={() => {
                    setAddress(knownAddr.address);
                    if (knownAddr.door_password) setDoorPw(knownAddr.door_password);
                    // 예전 주소는 지번이라 우편번호를 모름 — 배송지역·가격은 주소검색을 해야 정확해짐
                    setDeliveryKind(null); setPostalCode(''); setZoneGroup(null); setZoneError(true);
                    setKnownAddr(null);
                  }}
                  className="flex-1 py-2 bg-emerald-600 text-white rounded-lg text-xs font-bold">
                  이 주소 그대로
                </button>
                <button type="button" onClick={() => setKnownAddr(null)}
                  className="px-3 py-2 bg-white border border-emerald-200 text-emerald-700 rounded-lg text-xs font-bold">
                  다른 주소로
                </button>
              </div>
            </div>
          )}
          <Field label="주소">
            <button onClick={openPostcode} type="button"
              className="w-full py-3 bg-amber-50 border border-amber-300 rounded-xl text-amber-800 font-bold text-sm active:bg-amber-100 transition">
              🔍 주소 검색 {address ? '(다시 찾기)' : ''}
            </button>
            {address && (
              <>
                <div className="mt-2 text-sm text-stone-800 bg-white border border-stone-200 rounded-xl px-3 py-2.5">
                  {postalCode && <span className="text-xs text-stone-400">[{postalCode}] </span>}{address}
                </div>
                {/* 이번만 다른 곳으로 받는 경우가 있어서, 언제든 바꿀 수 있다는 걸 알려둠 */}
                <p className="text-[11px] text-stone-400 mt-1">이번에만 다른 곳으로 받으시려면 위에서 다시 검색하시면 돼요.</p>
              </>
            )}
          </Field>
          {/* 배송 종류 배너 */}
          {zoneChecking && <div className="mb-3 text-xs text-stone-400">배송 지역 확인 중…</div>}
          {deliveryKind === '직배송' && (
            <div className="mb-3 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5 text-xs text-amber-800 leading-relaxed">
              🚗 <span className="font-bold">직배송 지역</span>이에요! 저희가 직접 당일에 배송해드려요.
            </div>
          )}
          {deliveryKind === '당일배송' && (
            <div className="mb-3 bg-emerald-50 border border-emerald-200 rounded-xl px-3.5 py-2.5 text-xs text-emerald-800 leading-relaxed">
              ✅ <span className="font-bold">당일배송 가능 지역</span>이에요! (두발히어로{zoneGroup ? ` · ${zoneGroup} 구역` : ''})
            </div>
          )}
          {deliveryKind === '택배익일배송' && (
            <div className="mb-3 bg-blue-50 border border-blue-200 rounded-xl px-3.5 py-2.5 text-xs text-blue-800 leading-relaxed">
              📦 이 지역은 당일배송 구역이 아니라 <span className="font-bold">택배 익일배송</span>으로 보내드려요. (배송료 동일)
            </div>
          )}
          {zoneError && !zoneChecking && (
            <div className="mb-3 bg-red-50 border border-red-200 rounded-xl px-3.5 py-2.5 text-xs text-red-700 leading-relaxed">
              ⚠️ 배송 지역을 확인하지 못했어요. 이대로 주문하시면 <span className="font-bold">택배 익일배송</span>으로 접수돼요.
              <button type="button" onClick={retryResolveDelivery}
                className="mt-2 w-full py-2 bg-white border border-red-300 rounded-lg text-red-700 font-bold">
                다시 확인하기
              </button>
            </div>
          )}
          <Field label="상세주소"><input value={addressDetail} onChange={e=>setAddressDetail(e.target.value)} placeholder="동·호수 등" className={iCls}/></Field>
          <Field label="현관 비밀번호 (선택)"><input value={doorPw} onChange={e=>setDoorPw(e.target.value)} placeholder="예: #1234*" className={iCls}/></Field>
          {/* 예전엔 손님이 "저녁배송" 같은 요청을 남길 곳이 없어서 주소칸에 적어 넣곤 했음 */}
          <Field label="배송 요청사항 (선택)">
            <input value={customerRequest} onChange={e=>setCustomerRequest(e.target.value)}
              maxLength={60} placeholder="예: 저녁에 배송해주세요 / 문 앞에 두고 벨 눌러주세요" className={iCls}/>
          </Field>
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
                      <span className="text-amber-500 font-bold">{datePrice(o, tier).toLocaleString()}원</span>
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
              return s + getPrice(i.stage, i.volume, tier) * i.qty;
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
                                    {opt2.volume}g · {getPrice(it.stage!, opt2.volume, tier).toLocaleString()}원
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
                    // ⚠️ 예전엔 여기서 같은 이름의 지역변수(setQtyTotal)를 만들어 모듈 함수를 가렸는데,
                    // 그 계산엔 간단주문 팩수(_simpleQty)가 빠져 있어서 "지난번과 똑같이 주문"으로
                    // 불러온 세트가 팩수 0으로 보였음(가격은 정상 계산돼서 더 헷갈림).
                    const qtyOfSet = setQtyTotal(s);
                    const setSummary = s.stage && s.volume
                      ? `${s.stage} ${s.volume}g${qtyOfSet > 0 ? ` · ${qtyOfSet}팩` : ''}`
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
                                    onClick={()=>updSet(d.id, s.id, x=>({...x, stage:st, volume:null, menus: emptyMenus(), _simpleQty: undefined}))}
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
                                      onClick={()=>updSet(d.id, s.id, x=>({...x, volume:opt.volume, _simpleQty: undefined}))}
                                      className={`py-2 rounded-lg text-xs border transition ${s.volume===opt.volume?'bg-amber-500 border-amber-500 text-white':'bg-white border-amber-100 text-stone-700'}`}>
                                      {opt.volume}g · {getPrice(s.stage!, opt.volume, tier).toLocaleString()}원
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
                                  {/* ⚠️ 한우 비율은 여기서 막지 않는다 — 한우를 먼저 누르는 사람이 대부분인데
                                      나머지가 0이면 첫 1개부터 안 눌려서 "고장난 앱"이 됨.
                                      담는 건 자유롭게 두고, 날짜를 정리하는 버튼(주문 확인·날짜 추가)에서 확인한다. */}
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
                      <span>{datePrice(d, tier).toLocaleString()}원</span>
                    </div>
                  )}
                </div>}
              </div>
              );
            })}
          </div>

          {/* + 날짜 추가 — 지금 담은 날짜가 규칙에 맞는지 여기서 확인한다.
              (다음 날짜로 넘어가버리면 앞 날짜가 잘못된 걸 마지막에야 알게 됨) */}
          <button onClick={() => {
            if (!checkRules()) return;
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
              {/* 한우 비율 경고는 담는 중에 띄우지 않는다 — 한우부터 누르는 게 정상이라
                  담자마자 빨간 경고가 뜨면 잘못한 것처럼 보임. 정리 버튼을 누를 때만 알려준다. */}
              {ruleError && (
                <div className="mt-3 text-xs bg-rose-50 border border-rose-300 rounded-xl px-3 py-2.5 text-rose-800 font-bold leading-relaxed">
                  {ruleError}
                </div>
              )}

              {/* 최소 팩수를 못 채웠으면 막지 않고 픽업을 제안한다 — 1~2팩도 픽업이면 주문 가능 */}
              {shortForDelivery().length > 0 && (() => {
                const short = shortForDelivery();
                const need = short.reduce((s, x) => s + (MIN_ORDER_QTY - x.qty), 0);
                return (
                  <div className="mt-3 text-xs bg-amber-50 border border-amber-300 rounded-xl px-3 py-2.5">
                    <div className="font-bold text-amber-800">
                      {short.map(x => `${x.label} ${x.qty}팩`).join(' / ')} — 배송은 {MIN_ORDER_QTY}팩부터예요
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <button onClick={() => setIsPickup(false)}
                        className={`py-2 rounded-lg border text-xs font-bold ${!isPickup ? 'bg-white border-amber-400 text-amber-800' : 'bg-white/60 border-stone-200 text-stone-500'}`}>
                        {need}팩 더 담고 배송
                      </button>
                      <button onClick={() => setIsPickup(true)}
                        className={`py-2 rounded-lg border text-xs font-bold ${isPickup ? 'bg-amber-500 border-amber-500 text-white' : 'bg-white border-stone-200 text-stone-600'}`}>
                        이대로 픽업하기
                      </button>
                    </div>
                    {isPickup && (
                      <div className="text-amber-800 mt-1.5 font-bold">픽업으로 주문돼요 — 배송은 나가지 않아요</div>
                    )}
                  </div>
                );
              })()}

              {/* 3팩을 채웠는데 픽업이 켜져 있으면, 본인이 고른 건지 알 수 있게 남겨둔다 */}
              {isPickup && shortForDelivery().length === 0 && (
                <div className="mt-3 text-xs bg-amber-50 border border-amber-300 rounded-xl px-3 py-2.5 flex items-center justify-between gap-2">
                  <span className="font-bold text-amber-800">픽업(방문수령)으로 주문돼요</span>
                  <button onClick={() => setIsPickup(false)}
                    className="px-2.5 py-1.5 bg-white border border-amber-300 rounded-lg font-bold text-amber-800">배송으로 바꾸기</button>
                </div>
              )}
              <div className="mt-2 bg-stone-800 text-white rounded-xl px-4 py-3 flex justify-between text-sm font-bold">
                <span>전체 {dateOrders.reduce((s,d)=>s+dateQty(d),0)}팩</span>
                <span>{dateOrders.reduce((s,d)=>s+datePrice(d, tier),0).toLocaleString()}원</span>
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
            {/* 규칙 위반이어도 버튼을 잠그지 않는다 — 눌러야 왜 안 되는지 알 수 있으므로.
                날짜·팩수를 아직 안 고른 경우만 비활성화(그건 눌러도 할 말이 없음). */}
            <PrimaryBtn onClick={()=>{ if (checkRules()) goStep(4); }} disabled={!isStep3Ready()}>주문 확인</PrimaryBtn>
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
              <div className="font-bold text-amber-700 mb-2">{di+1}번째 — {d.delivery_date} ({dateQty(d)}팩 · {datePrice(d, tier).toLocaleString()}원)</div>
              {d.sets.filter(isFilledSet).map(s => (
                <div key={s.id} className="pl-3 mb-1 text-stone-700">
                  {isBanchanSet(s)
                    ? <span className="font-medium text-emerald-700">반찬 세트 {setQtyTotal(s)}세트 · {setPrice(s, tier).toLocaleString()}원</span>
                    : <><span className="font-medium">{s.stage} {s.volume}g</span>{' — '}{s._simpleQty?`${s._simpleQty}팩`:MENU_TYPES.filter(m=>s.menus[m]>0).map(m=>`${menuLabel(m)} ${s.menus[m]}팩`).join(' · ')}</>
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
            const orderTotal = dateOrders.reduce((s, d) => s + datePrice(d, tier), 0);
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
              <span>{(dateOrders.reduce((s,d)=>s+datePrice(d, tier),0) - usePoints).toLocaleString()}원</span>
            </div>
            {usePoints > 0 && (
              <div className="flex justify-between text-[11px] text-stone-400 mt-1">
                <span>{dateOrders.reduce((s,d)=>s+datePrice(d, tier),0).toLocaleString()}원 − 포인트 {usePoints.toLocaleString()}P</span>
              </div>
            )}
            {/* 배송비 줄이 없으면 "결제하고 나서 배송비가 또 붙나?" 하고 멈칫함 */}
            <div className="flex justify-between text-[11px] text-stone-400 mt-1.5 pt-1.5 border-t border-stone-700">
              <span>{isPickup ? '수령' : '배송비'}</span>
              <span>{isPickup ? '픽업(방문수령) · 배송비 없음' : tier === '직배송' ? '무료' : '팩 단가에 포함'}</span>
            </div>
          </div>
          {/* 취소 가능 시점을 결제 전에 알려주기 — 나중에 전화로 물어보는 걸 줄임 */}
          <p className="text-[11px] text-stone-400 mb-4 leading-relaxed text-center">
            주문 후에도 조리 준비가 시작되기 전까지는 <span className="font-bold text-stone-500">내 주문내역</span>에서 직접 취소할 수 있어요.
          </p>

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
function RegularSetup({ phone, babyName, initial, onSaved }: {
  phone: string;
  babyName: string;
  initial: {
    is_regular?: boolean; regular_schedule?: any; postal_code?: string | null;
    address?: string | null; address_detail?: string | null; door_password?: string | null;
  } | null;
  onSaved: () => void;
}) {
  const sched = initial?.regular_schedule || {};
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<StageType | null>(sched.stage ?? null);
  const [volume, setVolume] = useState<number | null>(sched.volume ?? null);
  // 요일 → 메뉴별 팩수. 팩수만 받으면 자동 주문이 조리표에 "메뉴 미지정"으로 떠서 조리를 못 함.
  const DAYS = ['월', '화', '목', '금'] as const;
  const emptyDayMenus = () => ({ 한우: 0, 닭: 0, 기타단백질: 0 } as Record<MenuType, number>);
  const initMenus: Record<string, Record<MenuType, number>> =
    { 월: emptyDayMenus(), 화: emptyDayMenus(), 목: emptyDayMenus(), 금: emptyDayMenus() };
  (sched.slots || []).forEach((s: any) => {
    if (!(s.day in initMenus)) return;
    if (Array.isArray(s.menus) && s.menus.length > 0) {
      s.menus.forEach((m: any) => { if (m?.menu in initMenus[s.day]) initMenus[s.day][m.menu as MenuType] = Number(m.qty) || 0; });
    } else if (Number(s.qty) > 0) {
      initMenus[s.day].한우 = Number(s.qty); // 메뉴 구분 없이 저장됐던 예전 신청 — 한우로 옮겨두고 고치게 함
    }
  });
  const [dayMenus, setDayMenus] = useState(initMenus);
  const dayQty = (day: string) => MENU_TYPES.reduce((a, m) => a + (dayMenus[day]?.[m] || 0), 0);
  // 받는 요일이 하나라도 있고, 받는 요일 전부가 최소 팩수를 넘어야 자동 주문이 서버 검증을 통과함
  const regularValid = DAYS.some(d => dayQty(d) > 0) && DAYS.every(d => dayQty(d) === 0 || dayQty(d) >= MIN_ORDER_QTY);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const isActive = !!initial?.is_regular;

  // 주소·지역 tier (가격 노출 조건)
  const [postalCode, setPostalCode] = useState(initial?.postal_code || '');
  const [addr, setAddr] = useState(initial?.address || '');
  const [addrDetail, setAddrDetail] = useState(initial?.address_detail || '');
  const [regDoorPw, setRegDoorPw] = useState(initial?.door_password || '');
  const [tier, setTier] = useState<PriceTier | null>(null);
  const [checking, setChecking] = useState(false);
  const DIRECT_GU = ['강서구', '양천구'];

  async function resolveTier(pc: string) {
    if (!/^\d{5}$/.test(pc)) { setTier(null); return; }
    setChecking(true);
    try {
      const SB = 'https://ymghmfkqctckxxysxkvy.supabase.co';
      const KEY = 'sb_publishable_3-9zobXqx6Nv36LzmNMBpA_fohZqA5x';
      const rows = await fetch(`${SB}/rest/v1/dubal_zones?postal_code=eq.${pc}&select=sido,gu`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      }).then(r => r.json());
      const row = Array.isArray(rows) ? rows[0] : null;
      const kind = row && String(row.sido || '').includes('서울') && DIRECT_GU.some(g => String(row.gu || '').includes(g))
        ? '직배송' : '기타';
      setTier(kind === '직배송' ? '직배송' : '기타');
    } catch { setTier(null); }
    finally { setChecking(false); }
  }
  useEffect(() => { if (initial?.postal_code) resolveTier(initial.postal_code); }, []);

  function openPostcode() {
    const daum = (window as any).daum;
    if (!daum?.Postcode) { alert('주소 검색을 불러오는 중이에요. 잠시 후 다시 눌러주세요.'); return; }
    new daum.Postcode({
      oncomplete: (data: any) => {
        setAddr(data.roadAddress || data.address || '');
        setPostalCode(data.zonecode || '');
        resolveTier(data.zonecode || '');
      },
    }).open();
  }

  async function save(active: boolean) {
    setSaving(true); setMsg(null);
    try {
      const slots = DAYS.filter(d => dayQty(d) > 0).map(day => ({ day, menus: dayMenus[day] }));
      const r = await fetch('/api/my/regular', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone, baby_name: babyName, active, stage, volume, slots,
          postal_code: postalCode, address: addr, address_detail: addrDetail, door_password: regDoorPw,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '저장 실패');
      // 예전엔 "신청됐어요"만 띄우고 실제 주문은 자정에야 바뀌어서, 바로 확인해보면
      // 팩수가 그대로라 저장이 안 된 것처럼 보였음 — 몇 건이 반영됐는지 같이 알려준다.
      const s = d.sync;
      const moved = s ? s.created + s.updated + s.revived + s.cancelled : 0;
      setMsg(!active ? '정기배송이 해지됐어요'
        : moved > 0 ? `정기배송이 저장됐어요! 예정된 주문 ${moved}건에 바로 반영했어요.`
        : '정기배송이 저장됐어요! (예정된 주문은 매일 자정에 만들어져요)');
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
            매주 원하는 요일·수량을 등록하면 자동으로 주문돼요. 배송지·단계·용량과 요일별 팩 수를 골라주세요.
          </p>
          {/* 배송지 (tier 확정용) */}
          <div>
            <button onClick={openPostcode} type="button"
              className="w-full py-2.5 bg-emerald-50 border border-emerald-300 rounded-xl text-emerald-800 font-bold text-xs active:bg-emerald-100">
              🔍 배송지 검색 {postalCode ? '(다시 찾기)' : ''}
            </button>
            {(addr || postalCode) && (
              <div className="mt-1.5 text-xs text-stone-700 bg-white border border-stone-200 rounded-lg px-3 py-2">
                {postalCode && <span className="text-stone-400">[{postalCode}] </span>}{addr || '등록된 배송지'}
                {checking && <span className="ml-1 text-stone-400">확인 중…</span>}
                {tier === '직배송' && <span className="ml-1 text-amber-600 font-bold">· 직배송</span>}
                {tier === '기타' && <span className="ml-1 text-emerald-600 font-bold">· 당일/택배</span>}
              </div>
            )}
            {/* 자동 주문에 그대로 실려 나가는 주소 — 동·호수가 없으면 배송을 못 함 */}
            <input value={addrDetail} onChange={e => setAddrDetail(e.target.value)} maxLength={50}
              placeholder="상세주소 (동·호수)"
              className="mt-1.5 w-full px-3 py-2 bg-white border border-stone-200 rounded-lg text-[16px] outline-none focus:border-emerald-400" />
            <input value={regDoorPw} onChange={e => setRegDoorPw(e.target.value)} maxLength={20}
              placeholder="현관 비밀번호 (선택)"
              className="mt-1.5 w-full px-3 py-2 bg-white border border-stone-200 rounded-lg text-[16px] outline-none focus:border-emerald-400" />
          </div>
          {/* 단계 */}
          <div className="grid grid-cols-4 gap-1.5">
            {STAGES.map(st => (
              <button key={st} onClick={() => { setStage(st); setVolume(null); }}
                className={`py-2 rounded-lg text-[11px] font-bold border ${stage === st ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-stone-200 text-stone-600'}`}>
                {st.replace('중기1단계', '중1').replace('중기2단계', '중2').replace('완료기', '완료')}
              </button>
            ))}
          </div>
          {/* 용량 (가격은 배송지 확정 후 표시) */}
          {stage && (
            <>
              {tier === null && (
                <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">💡 배송지 입력 후 가격이 표시돼요</div>
              )}
              <div className="grid grid-cols-2 gap-1.5">
                {STAGE_OPTIONS[stage].map(o => (
                  <button key={o.volume} onClick={() => setVolume(o.volume)}
                    className={`py-2 rounded-lg text-xs border ${volume === o.volume ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-stone-200 text-stone-600'}`}>
                    {o.volume}g{tier !== null ? ` · ${getPrice(stage!, o.volume, tier).toLocaleString()}원` : ''}
                  </button>
                ))}
              </div>
            </>
          )}
          {/* 요일별 메뉴 팩수 — 조리표에 한우/닭/기타가 찍히게 하려면 여기서 나눠 받아야 함 */}
          <div className="space-y-2">
            {DAYS.map(day => {
              const q = dayQty(day);
              return (
                <div key={day} className={`rounded-xl px-3 py-2 border ${q > 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-stone-50 border-stone-100'}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-bold text-stone-700">{day}요일</span>
                    <span className={`text-[11px] font-bold ${q > 0 ? 'text-emerald-700' : 'text-stone-400'}`}>{q > 0 ? `${q}팩` : '안 받음'}</span>
                  </div>
                  <div className="space-y-1">
                    {MENU_TYPES.map(m => (
                      <div key={m} className="flex items-center justify-between">
                        <span className="text-xs text-stone-600">{menuLabel(m)}</span>
                        <QtyCtrl value={dayMenus[day][m]}
                          onChange={v => setDayMenus(p => ({ ...p, [day]: { ...p[day], [m]: Math.max(0, Math.min(10, v)) } }))} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {/* 1회 배송 최소 팩수 — 자동 주문도 같은 규칙을 타므로 신청 때 미리 알려준다 */}
          {DAYS.some(d => dayQty(d) > 0 && dayQty(d) < MIN_ORDER_QTY) && (
            <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 leading-relaxed">
              받는 요일은 하루 {MIN_ORDER_QTY}팩 이상이어야 해요 ({DAYS.filter(d => dayQty(d) > 0 && dayQty(d) < MIN_ORDER_QTY).map(d => `${d} ${dayQty(d)}팩`).join(', ')})
            </div>
          )}
          {msg && <div className="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">{msg}</div>}
          <div className="flex gap-2">
            <button onClick={() => save(true)} disabled={saving || !stage || !volume || !postalCode || !addr || !regularValid}
              className="flex-1 py-2.5 bg-emerald-500 text-white text-sm font-bold rounded-xl disabled:bg-stone-200">
              {saving ? '저장 중…' : (!postalCode || !addr) ? '배송지를 입력해주세요' : !regularValid ? `받는 요일마다 ${MIN_ORDER_QTY}팩 이상 담아주세요` : isActive ? '변경 저장' : '정기배송 신청'}
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
  // 세 번째 메뉴 타입은 데이터상 'other'로 들어옴 ('p3'는 예전 표기) — 둘 다 받아준다
  const TYPE_KOR: Record<string, string> = { hanwoo: '한우', chicken: '닭', p3: '기타단백질', other: '기타단백질' };
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
  return <div className="max-w-md mx-auto px-4 py-6 pb-36 safe-top">{children}</div>;
}
// 홈 화면에서 앱을 설치(PWA)해서 쓰면 브라우저 주소창이 없어서 /admin으로 갈 방법이 없었음 —
// 손님에게는 눈에 안 띄되 사장님은 언제든 누를 수 있는 위치(맨 아래)에 조용히 둔다.
function AdminLink() {
  return (
    <div className="mt-10 pt-4 border-t border-stone-100 text-center">
      <a href="/admin" className="text-[11px] text-stone-300 hover:text-stone-500 active:text-stone-500 py-2 px-3 inline-block">
        관리자 로그인
      </a>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h2 className="text-[19px] font-extrabold text-stone-900 mb-4 tracking-[-0.02em]">{title}</h2>{children}</section>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block mb-3.5"><span className="text-xs text-stone-500 font-semibold mb-1.5 block tracking-[-0.01em]">{label}</span>{children}</label>;
}
function SRow({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-3 py-1 border-b border-stone-50 last:border-0"><span className="text-stone-400">{k}</span><span className="text-stone-900 font-medium text-right">{v}</span></div>;
}
function StepBar({ current, total }: { current: number; total: number }) {
  return <div className="flex gap-1 mt-2">{Array.from({length:total}).map((_,i)=>
    <div key={i} className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${i+1<=current?'bg-amber-500':'bg-amber-100'}`}/>)}</div>;
}
function PrimaryBtn({ onClick, disabled, children }: { onClick:()=>void; disabled?:boolean; children:React.ReactNode }) {
  return <button onClick={onClick} disabled={disabled} className="flex-1 py-3.5 bg-amber-500 text-white font-bold rounded-xl shadow-sm shadow-amber-500/25 active:bg-amber-600 disabled:bg-stone-200 disabled:text-stone-400 disabled:shadow-none">{children}</button>;
}
function BackBtn({ onClick }: { onClick:()=>void }) {
  return <button onClick={onClick} className="px-5 py-3.5 bg-white border border-amber-100 text-stone-600 font-semibold rounded-xl active:bg-amber-50">이전</button>;
}
function Row2({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2 mt-5">{children}</div>;
}
function QtyCtrl({ value, onChange }: { value:number; onChange:(v:number)=>void }) {
  // 터치 타깃을 44px 가깝게 키움(모바일 접근성 권장치) + 선택된 수량은 색으로 구분
  return <div className="flex items-center gap-1.5">
    <button aria-label="수량 줄이기" onClick={()=>onChange(value-1)} disabled={value<=0}
      className="w-10 h-10 rounded-xl bg-amber-100 text-amber-800 font-black text-xl leading-none disabled:opacity-25 flex items-center justify-center active:bg-amber-200">−</button>
    <span className={`w-8 text-center font-extrabold text-[17px] tabular-nums ${value>0?'text-amber-700':'text-stone-300'}`}>{value}</span>
    <button aria-label="수량 늘리기" onClick={()=>onChange(value+1)} disabled={value>=10}
      className="w-10 h-10 rounded-xl bg-amber-100 text-amber-800 font-black text-xl leading-none disabled:opacity-25 flex items-center justify-center active:bg-amber-200">+</button>
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
            새 재료는 <span className="font-bold text-amber-600">🧪 테스트</span>로 시작하세요. 흔히 한 번에 한 가지만, <span className="font-bold">3일간</span> 간격을 두고 이상반응(발진·설사 등)을 지켜보라고 하는데, 정확한 기준은 다니시는 소아과에 확인하시는 걸 권장드려요. 괜찮으면 <span className="font-bold text-emerald-600">✅ 안전</span>, 이상하면 <span className="font-bold text-rose-600">🚫 알레르기</span> — 알레르기로 표시하면 메뉴 경고에 자동 반영돼요.
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
                    <div className="text-xs text-stone-700 min-w-0 flex-1">
                      <div className="font-medium truncate">{a.emoji} {a.label}</div>
                      <div className="text-[10px] text-amber-600">
                        {days === 0 ? '오늘 시작' : `${days}일째`}{days >= 3 ? ' · 관찰 완료!' : ` (3일 중 ${days}일)`}
                      </div>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <button onClick={() => update(k, 'safe')} className="text-[11px] font-bold text-emerald-700 bg-emerald-100 px-2 py-1 rounded whitespace-nowrap">✅ 안전</button>
                      <button onClick={() => update(k, 'allergic')} className="text-[11px] font-bold text-rose-700 bg-rose-100 px-2 py-1 rounded whitespace-nowrap">🚫 알레르기</button>
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
                  <span className={`text-xs font-medium min-w-0 truncate ${st === 'allergic' ? 'text-rose-600' : st === 'safe' ? 'text-emerald-700' : 'text-stone-600'}`}>
                    {a.emoji} {a.label}
                  </span>
                  <div className="flex gap-1 flex-shrink-0">
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
