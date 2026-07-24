// ────────────────────────────────────────────────────────────────
// 초개인화 로직 모음 (클라이언트 · localStorage 기반)
//  ① 개월수 → 단계 자동추천 / ⑤ 성장단계 안내
//  ② 알레르기 첫도입 도우미 + ④ 먹어본 재료 트래킹 (재료 도감)
//  ③ 원클릭 재주문 / ⑥ 재주문 리마인더
// ────────────────────────────────────────────────────────────────
import type { StageType } from './supabase';

// ── ① 개월수 → 단계 추천 ─────────────────────────────────────────
export function recommendStage(months: number): StageType | null {
  if (!months || months <= 0) return null;
  if (months <= 8) return '중기1단계';   // 6~8개월
  if (months === 9) return '중기2단계';  // 9개월
  if (months <= 11) return '후기';       // 10~11개월
  return '완료기';                       // 12개월+
}

export function stageGuide(months: number): string {
  const s = recommendStage(months);
  if (!s) return '';
  const map: Record<StageType, string> = {
    '중기1단계': '6~8개월 아기에게 알맞은 단계예요',
    '중기2단계': '9개월 무렵 아기에게 알맞은 단계예요',
    '후기': '10~11개월 아기에게 알맞은 단계예요',
    '완료기': '12개월 이후 아기에게 알맞은 단계예요',
  };
  return map[s];
}

// ── ⑤ 성장단계 전환 안내 ─────────────────────────────────────────
// 이전에 주로 시킨 단계보다 추천 단계가 높으면 "넘어갈 시기" 안내
export function stageTransitionNote(months: number, lastStage?: StageType): string | null {
  const rec = recommendStage(months);
  if (!rec || !lastStage) return null;
  const order: StageType[] = ['중기1단계', '중기2단계', '후기', '완료기'];
  if (order.indexOf(rec) > order.indexOf(lastStage)) {
    return `${months}개월이면 이제 '${rec}'로 넘어갈 시기예요. 지난번엔 '${lastStage}'을(를) 주문하셨어요.`;
  }
  return null;
}

// ── ②④ 재료 도감 (food diary) ───────────────────────────────────
export type FoodStatus = 'none' | 'testing' | 'safe' | 'allergic';
export type DiaryEntry = { status: FoodStatus; startDate?: string };
export type Diary = Record<string, DiaryEntry>; // key = allergen key (재료)

const DIARY_KEY = 'bfo_food_diary';

export function loadDiary(): Diary {
  try { const s = localStorage.getItem(DIARY_KEY); return s ? JSON.parse(s) : {}; } catch { return {}; }
}
export function saveDiary(d: Diary) {
  try { localStorage.setItem(DIARY_KEY, JSON.stringify(d)); } catch {}
}
export function setFoodStatus(key: string, status: FoodStatus): Diary {
  const d = loadDiary();
  if (status === 'none') { delete d[key]; }
  else { d[key] = { status, startDate: status === 'testing' ? new Date().toISOString().slice(0, 10) : d[key]?.startDate }; }
  saveDiary(d);
  return d;
}
export function foodKeysByStatus(d: Diary, status: FoodStatus): string[] {
  return Object.entries(d).filter(([, v]) => v.status === status).map(([k]) => k);
}
// 관찰 시작 후 경과일
export function testingDays(entry: DiaryEntry): number {
  if (!entry.startDate) return 0;
  const start = new Date(entry.startDate + 'T00:00:00');
  return Math.floor((Date.now() - start.getTime()) / 86400000);
}

// ── ③⑥ 원클릭 재주문 / 재주문 리마인더 ──────────────────────────
export type SavedSet = { stage: StageType | null; volume: number | null; menus: Record<string, number>; simpleQty?: number };
export type LastOrder = { savedAt: string; sets: SavedSet[] };

const LAST_ORDER_KEY = 'bfo_last_order';

export function saveLastOrder(sets: SavedSet[]) {
  try { localStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ savedAt: new Date().toISOString().slice(0, 10), sets })); } catch {}
}
export function loadLastOrder(): LastOrder | null {
  try { const s = localStorage.getItem(LAST_ORDER_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
// 마지막 주문 후 경과일
export function daysSinceLastOrder(lo: LastOrder | null): number | null {
  if (!lo?.savedAt) return null;
  const d = new Date(lo.savedAt + 'T00:00:00');
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
