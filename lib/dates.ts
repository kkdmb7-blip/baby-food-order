import { COOKING_DAYS, COOKING_DAY_KOR } from './supabase';

export function kstNow(): Date {
  return new Date(Date.now() + 9 * 3600 * 1000);
}

export function kstToday(): string {
  return kstNow().toISOString().slice(0, 10);
}

export function fmtDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : '')) : iso;
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}-${String(k.getUTCDate()).padStart(2, '0')}`;
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${fmtDate(k)} ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
}

// 이번 주 월요일 (KST 기준)
// 일요일 자정 기준으로 주 전환 — 일요일이면 다음 주 월요일 반환
export function thisWeekMonday(): string {
  const now = kstNow();
  const dow = now.getUTCDay(); // 0=Sun
  const diffToMon = dow === 0 ? 1 : 1 - dow; // 일=+1(다음월요일), 나머지=이번주 월요일
  const mon = new Date(now.getTime() + diffToMon * 86400000);
  return mon.toISOString().slice(0, 10);
}

// KST 날짜 문자열 생성 (이중 오프셋 없음)
function kstDateStr(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// 특정 주(月요일 기준)의 조리 가능 날짜 반환
export function weekDateOptions(weekOffset = 0): { value: string; label: string; dow: number; past: boolean }[] {
  const nowKST = Date.now() + 9 * 3600 * 1000;
  const todayStr = kstDateStr(nowKST);

  // 이번 주 월요일 찾기 (일요일 자정 기준 — 일요일은 다음 주로 취급)
  const nowD = new Date(nowKST);
  const todayDow = nowD.getUTCDay(); // 0=Sun
  const diffToMon = todayDow === 0 ? 1 : 1 - todayDow;
  const thisMon = nowKST + diffToMon * 86400000 + weekOffset * 7 * 86400000;

  const out: { value: string; label: string; dow: number; past: boolean }[] = [];
  // 월(1) 화(2) 목(4) 금(5)
  for (const offset of [0, 1, 3, 4]) {
    const ts = thisMon + offset * 86400000;
    const d = new Date(ts);
    const dow = d.getUTCDay();
    if (!(COOKING_DAYS as readonly number[]).includes(dow)) continue;
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const value = kstDateStr(ts);
    const label = `${m}/${day} (${COOKING_DAY_KOR[dow]})`;
    // 서버가 "조리일은 내일 이후"만 허용하므로(api/orders) 오늘도 마감 처리해야 함 —
    // `<`로 두면 오늘 날짜가 선택 가능해서, 주문을 다 채우고 마지막 제출에서야 거부당했음.
    const past = value <= todayStr;
    out.push({ value, label, dow, past });
  }
  return out;
}

// 이번 주 월요일 (일요일 자정 기준)
export function weekMonday(weekOffset = 0): string {
  const nowKST = Date.now() + 9 * 3600 * 1000;
  const nowD = new Date(nowKST);
  const todayDow = nowD.getUTCDay();
  const diffToMon = todayDow === 0 ? 1 : 1 - todayDow;
  const monTs = nowKST + diffToMon * 86400000 + weekOffset * 7 * 86400000;
  return kstDateStr(monTs);
}

// 가까운 조리 가능 날짜 8개 (주 경계 무관 — 간단주문·레거시용)
export function deliveryDateOptions(): { value: string; label: string; dow: number }[] {
  const nowKST = Date.now() + 9 * 3600 * 1000;
  const todayStr = kstDateStr(nowKST);
  const out: { value: string; label: string; dow: number }[] = [];
  for (let i = 1; i <= 21 && out.length < 8; i++) {
    const ts = nowKST + i * 86400000;
    const d = new Date(ts);
    const dow = d.getUTCDay();
    if (!(COOKING_DAYS as readonly number[]).includes(dow)) continue;
    const value = kstDateStr(ts);
    if (value <= todayStr) continue;
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    out.push({ value, label: `${m}/${day} (${COOKING_DAY_KOR[dow]})`, dow });
  }
  return out;
}

// 메뉴보기용 — 월~금 전체 (수=반찬 날 포함)
export function allWeekDays(weekOffset = 0): { value: string; label: string; dow: number; past: boolean; isBanchan: boolean }[] {
  const nowKST = Date.now() + 9 * 3600 * 1000;
  const todayStr = kstDateStr(nowKST);
  const nowD = new Date(nowKST);
  const todayDow = nowD.getUTCDay();
  const diffToMon = todayDow === 0 ? 1 : 1 - todayDow;
  const thisMon = nowKST + diffToMon * 86400000 + weekOffset * 7 * 86400000;
  const DOW_KOR: Record<number, string> = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금' };
  return [0, 1, 2, 3, 4].map(offset => {
    const ts = thisMon + offset * 86400000;
    const d = new Date(ts);
    const dow = d.getUTCDay();
    const value = kstDateStr(ts);
    // 메뉴보기 화면에서도 그대로 주문으로 이어지므로 주문 가능 기준(내일 이후)과 동일하게 맞춤
    return { value, label: `${d.getUTCMonth()+1}/${d.getUTCDate()} (${DOW_KOR[dow]})`, dow, past: value <= todayStr, isBanchan: dow === 3 };
  });
}

export function formatPhone(p: string) {
  const d = (p || '').replace(/[^\d]/g, '');
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}
