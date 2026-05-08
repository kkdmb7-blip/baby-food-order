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
export function thisWeekMonday(): string {
  const now = kstNow();
  const dow = now.getUTCDay(); // 0=Sun
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(now.getTime() + diffToMon * 86400000);
  return mon.toISOString().slice(0, 10);
}

// 조리일 옵션: 오늘 이후 최대 7일 내 조리 가능 요일 (월/화/목/금)
export function deliveryDateOptions(): { value: string; label: string; dow: number }[] {
  const out: { value: string; label: string; dow: number }[] = [];
  const base = kstNow();
  // 당일 오전 9시 이전이면 오늘도 가능, 이후면 내일부터
  const hour = base.getUTCHours();
  const startOffset = hour < 0 ? 0 : 1; // 당일 주문 사전 마감 없으면 0, 아니면 1
  for (let i = startOffset; i <= 14 && out.length < 8; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    const dow = d.getUTCDay();
    if (!(COOKING_DAYS as readonly number[]).includes(dow)) continue;
    const value = fmtDate(d);
    const label = `${d.getUTCMonth() + 1}/${d.getUTCDate()} (${COOKING_DAY_KOR[dow]})`;
    out.push({ value, label, dow });
  }
  return out;
}

export function formatPhone(p: string) {
  const d = (p || '').replace(/[^\d]/g, '');
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}
