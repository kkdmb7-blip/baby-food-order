import type { StageType } from './supabase';

/*
  손님 브라우저(localStorage)에 남겨두는 것들 — 저장한 내 정보, 배송지 주소록,
  담다 만 주문, 유입경로·추천인 코드, 소개화면을 봤는지.

  왜 따로 뒀나
    app/order/page.tsx 가 3,650줄이라 고치다 엉뚱한 데를 건드리기 쉬웠다.
    여기 있는 것은 화면 상태를 안 쓰고 저장소만 다루므로 떼어내도 동작이 그대로다.

  ⚠️ 모든 읽기·쓰기를 try/catch 로 감싼다. 시크릿 창이나 저장을 막아둔 기기에서는
     localStorage 접근 자체가 예외를 던져서, 안 감싸면 주문 화면이 통째로 안 뜬다.
     여기서는 '못 읽으면 없는 것으로' 가 맞는 처리라 조용히 넘어간다.
*/

const SAVED_KEY = 'bfo_saved_info';
const ADDR_BOOK_KEY = 'bfo_address_book';
const DRAFT_KEY = 'bfo_order_draft';
const DRAFT_TTL = 24 * 3600 * 1000;
export const ACQ_SOURCE_KEY = 'bfo_acquisition_source'; // 유입경로 — 최초 1회만 기록(퍼스트터치)
export const REF_CODE_KEY = 'bfo_referral_code';        // 공유링크(?ref=코드)로 들어온 추천인 코드
const INTRO_SEEN_KEY = 'bfo_intro_seen';

export type SavedInfo = {
  babyName: string; months: string; phone: string;
  address: string; addressDetail: string; doorPw: string;
  lastStage?: StageType; lastVolume?: number; // 간단주문 기본값
  allergies?: string[]; // 알레르기 키 목록 (한 번 등록 → 유지)
  postalCode?: string; zoneGroup?: string | null; deliveryKind?: string | null; // 배송권역
};

export function loadSaved(): SavedInfo | null {
  try { const s = localStorage.getItem(SAVED_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function doSave(info: SavedInfo) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(info)); } catch {}
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

export function loadAddrBook(): SavedAddress[] {
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
export function saveAddrBook(list: SavedAddress[]) {
  try { localStorage.setItem(ADDR_BOOK_KEY, JSON.stringify(list)); } catch {}
}

// ── 담던 주문 임시저장 ───────────────────────────────────────────
// 날짜·메뉴를 다 골라놓고 전화가 와서 앱을 벗어나면 처음부터 다시 해야 했음.
// 큰 앱의 장바구니처럼 하루 동안 남겨둔다.
export function saveDraft(dateOrders: unknown) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ at: Date.now(), dateOrders })); } catch {}
}
export function loadDraft(): any[] | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d?.at || Date.now() - d.at > DRAFT_TTL) { localStorage.removeItem(DRAFT_KEY); return null; }
    return Array.isArray(d.dateOrders) ? d.dateOrders : null;
  } catch { return null; }
}
export function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} }

// ── 소개 화면 ────────────────────────────────────────────────────
// 못 읽으면 '봤다'로 본다 — 저장이 막힌 기기에서 올 때마다 소개가 뜨면 성가시다.
export function introSeen(): boolean {
  try { return localStorage.getItem(INTRO_SEEN_KEY) === '1'; } catch { return true; }
}
export function markIntroSeen() {
  try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch {}
}
