import { STAGES, STAGE_OPTIONS, MENU_TYPES, type StageType } from './supabase';

/*
  여덟 칸 — 중기1 240·310, 중기2 230·300, 후기 230·300, 완료기 230·300

  엑셀의 '조리갯수' 시트가 이 모양이었다. 단계·용량 자리를 고정해 두고 해당 자리에
  숫자를 적는다. 한 사람이 같은 단계를 다른 용량으로도, 다른 단계를 같은 용량으로도
  시키기 때문에 칸을 하나만 고르게 만들면 그런 주문을 넣을 수 없다 — 그래서 다 열어둔다.

  주문접수(GridEntry)와 조리표 고치기(SheetEditor)가 같은 칸을 써야 하므로 여기 둔다.
*/

export type Slot = { stage: StageType; volume: number; key: string; label: string; isBig: boolean };

export const SLOTS: Slot[] = STAGES.flatMap(s => {
  const vols = STAGE_OPTIONS[s].map(o => o.volume);
  const big = Math.max(...vols);
  return vols.map(v => ({
    stage: s, volume: v, key: `${s}|${v}`,
    label: `${s.replace('단계', '')} ${v}g`, isBig: v === big,
  }));
});

export const slotKey = (stage: string | null | undefined, volume: number | null | undefined) =>
  `${stage ?? '-'}|${volume ?? 0}`;

export const slotOf = (stage: string | null | undefined, volume: number | null | undefined) =>
  SLOTS.find(s => s.key === slotKey(stage, volume)) || null;

/**
 * 메뉴를 안 적어 보내신 팩을 나눠 담는다 — 사장님이 손으로 하시던 방식 그대로.
 *
 *   한우 → 닭 → 기타 순으로 앞에서부터 하나씩 돌려 담는다.
 *     4팩 → 한우2·닭1·기타1      6팩 → 2개씩      5팩 → 한우2·닭2·기타1
 *   팩수조차 안 적혀 있으면 종류별로 1팩씩(3팩).
 *
 * 임의로 채워 두는 값이다 — 화면에 '자동으로 채웠다' 고 적어서 고치실 수 있게 한다.
 */
export function spreadPacks(qty: number): Record<string, number> {
  const n = Math.max(0, Math.floor(Number(qty) || 0)) || MENU_TYPES.length;
  const out: Record<string, number> = {};
  const base = Math.floor(n / MENU_TYPES.length);
  const rest = n % MENU_TYPES.length;
  MENU_TYPES.forEach((m, i) => {
    const v = base + (i < rest ? 1 : 0);
    if (v > 0) out[m] = v;
  });
  return out;
}

/**
 * 주문서에 적힌 용량을 그 단계의 칸으로 맞춘다.
 * 양식 안내문이 "230g 또는 300g" 이라 중기1단계도 230·300 으로 적어 보내신다.
 * 중기1은 240·310 이다 — 중기2를 한 번 더 갈아 다시 끓이면서 양이 늘기 때문이다.
 * 10g 차이까지만 맞춘다. 그보다 멀면 잘못 적힌 것이니 사장님께 알린다.
 */
export function fitSlot(stage: StageType, volume: number): Slot | null {
  const mine = SLOTS.filter(s => s.stage === stage);
  if (!mine.length || !volume) return null;
  const exact = mine.find(s => s.volume === volume);
  if (exact) return exact;
  const near = mine.reduce((a, b) => (Math.abs(b.volume - volume) < Math.abs(a.volume - volume) ? b : a));
  return Math.abs(near.volume - volume) <= 10 ? near : null;
}
