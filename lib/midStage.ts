// ────────────────────────────────────────────────────────────────
// 중기에서 빼고 조리하는 재료
//
// 메뉴 프로그램(kkakung-menu)에서 "새우는 중기에서 뺀다"로 고정해 두었고,
// 메뉴표·메뉴이미지도 중기 줄에서는 새우를 지운 이름·재료로 나간다.
// 그런데 주문앱은 세 단계에 같은 재료를 그대로 보여주고 있었다.
//
// 그래서 새우 알레르기를 등록한 손님이 중기를 시키려 하면
// 실제로는 새우가 안 들어가는 팩인데도 "주문할 수 없어요"로 막혔다.
// 손님은 못 시키고 가게는 판매를 잃는다.
//
// ⚠️ 이 목록은 메뉴 프로그램의 MID_STAGE_BANNED와 같아야 한다.
//    한쪽만 바꾸면 표시와 실제가 어긋난다.
// ────────────────────────────────────────────────────────────────

export const MID_STAGE_BANNED = ['새우'];

/** 주문앱 단계는 '중기1단계'·'중기2단계'로 나뉘어 있다. 둘 다 중기다. */
export function isMidStage(stage?: string | null): boolean {
  return !!stage && stage.startsWith('중기');
}

/** 이 메뉴에서 중기에 빠지는 재료 목록 */
export function bannedInMidStage(ingredients?: string | null): string[] {
  const list = String(ingredients || '').split(',').map(s => s.trim());
  return MID_STAGE_BANNED.filter(b => list.some(x => x === b || x.includes(b)));
}

function keeps(banned: string[]) {
  return (x: string) => !!x && !banned.some(b => x === b || x.includes(b));
}

/** 재료 문자열에서 빠지는 재료를 지운다 */
export function stripIngredients(ingredients?: string | null, banned?: string[]): string {
  const b = banned ?? bannedInMidStage(ingredients);
  if (!b.length) return String(ingredients || '');
  return String(ingredients || '').split(',').map(s => s.trim()).filter(keeps(b)).join(', ');
}

/** 메뉴 이름에서도 지운다. 다 지워지면 원래 이름을 남긴다(빈 이름 방지). */
export function stripName(name?: string | null, banned?: string[]): string {
  const original = String(name || '');
  const b = banned ?? [];
  if (!b.length) return original;
  const out = original.split(/\s+/).filter(keeps(b)).join(' ').trim();
  return out || original;
}

export type StageMenu = { name: string; ingredients: string; dropped: string[] };

/** 단계에 맞는 메뉴 이름·재료를 돌려준다. 중기가 아니면 그대로. */
export function menuForStage(
  menu: { name?: string | null; ingredients?: string | null },
  stage?: string | null
): StageMenu {
  const name = String(menu.name || '');
  const ingredients = String(menu.ingredients || '');
  if (!isMidStage(stage)) return { name, ingredients, dropped: [] };
  const dropped = bannedInMidStage(ingredients);
  if (!dropped.length) return { name, ingredients, dropped: [] };
  return {
    name: stripName(name, dropped),
    ingredients: stripIngredients(ingredients, dropped),
    dropped,
  };
}
