// ────────────────────────────────────────────────────────────────
// 알레르기 판별 사전 (정확 버전)
// 식약처 표시대상 알레르기 19종 + 이유식에서 흔한 재료를 매핑.
// 메뉴 재료 텍스트(예: "한우, 당근, 시금치, 한우육수")에서 알레르겐을
// 표기가 달라도(한우=쇠고기, 달걀=계란=난류) 잡아내기 위한 동의어 사전.
// ────────────────────────────────────────────────────────────────

export type Allergen = {
  key: string;      // 내부 식별자
  label: string;    // 표시명
  emoji: string;
  keywords: string[]; // 재료 텍스트에서 이 알레르겐으로 간주할 단어들
};

// keywords는 "부분 일치"로 검사한다. (재료 "닭가슴살" ⊇ 키워드 "닭")
// 오탐을 줄이려고 너무 짧은 단어(예: '게')는 신중히 배치.
export const ALLERGENS: Allergen[] = [
  { key: 'egg',      label: '달걀(난류)', emoji: '🥚', keywords: ['달걀', '계란', '난류', '노른자', '흰자', '메추리알'] },
  { key: 'milk',     label: '우유(유제품)', emoji: '🥛', keywords: ['우유', '분유', '치즈', '요구르트', '요거트', '버터', '생크림', '유제품', '연유'] },
  { key: 'beef',     label: '쇠고기', emoji: '🐄', keywords: ['쇠고기', '소고기', '한우', '우육', '사골', '소사골'] },
  { key: 'chicken',  label: '닭고기', emoji: '🐔', keywords: ['닭', '닭고기', '닭가슴살', '계육'] },
  { key: 'pork',     label: '돼지고기', emoji: '🐖', keywords: ['돼지', '돼지고기', '삼겹', '돈육', '안심(돼지)'] },
  { key: 'wheat',    label: '밀', emoji: '🌾', keywords: ['밀', '밀가루', '소면', '국수', '빵', '면', '수제비', '밀배아'] },
  { key: 'soy',      label: '대두(콩)', emoji: '🫘', keywords: ['대두', '콩', '두부', '된장', '간장', '두유', '콩가루', '유부'] },
  { key: 'peanut',   label: '땅콩', emoji: '🥜', keywords: ['땅콩'] },
  { key: 'walnut',   label: '호두', emoji: '🌰', keywords: ['호두'] },
  { key: 'pinenut',  label: '잣', emoji: '🌰', keywords: ['잣'] },
  { key: 'peach',    label: '복숭아', emoji: '🍑', keywords: ['복숭아'] },
  { key: 'tomato',   label: '토마토', emoji: '🍅', keywords: ['토마토', '방울토마토'] },
  { key: 'shrimp',   label: '새우', emoji: '🦐', keywords: ['새우', '대하'] },
  { key: 'crab',     label: '게', emoji: '🦀', keywords: ['꽃게', '게살', '게다리', '대게'] },
  { key: 'squid',    label: '오징어', emoji: '🦑', keywords: ['오징어', '한치'] },
  { key: 'shellfish',label: '조개류', emoji: '🐚', keywords: ['조개', '굴', '전복', '홍합', '바지락', '가리비', '소라'] },
  { key: 'mackerel', label: '고등어', emoji: '🐟', keywords: ['고등어'] },
  { key: 'fish',     label: '생선', emoji: '🐠', keywords: ['대구', '연어', '광어', '가자미', '동태', '명태', '북어', '멸치', '갈치', '삼치', '생선'] },
  { key: 'buckwheat',label: '메밀', emoji: '🌾', keywords: ['메밀'] },
  { key: 'sulfite',  label: '아황산류', emoji: '⚗️', keywords: ['아황산', '건조과일', '건포도'] },
  // ── 이유식에서 자주 조심하는 추가 재료 (공식 19종 외) ──
  { key: 'carrot',   label: '당근', emoji: '🥕', keywords: ['당근'] },
  { key: 'spinach',  label: '시금치', emoji: '🥬', keywords: ['시금치'] },
  { key: 'broccoli', label: '브로콜리', emoji: '🥦', keywords: ['브로콜리'] },
  { key: 'potato',   label: '감자', emoji: '🥔', keywords: ['감자'] },
  { key: 'sweetpotato', label: '고구마', emoji: '🍠', keywords: ['고구마'] },
  { key: 'pumpkin',  label: '단호박/애호박', emoji: '🎃', keywords: ['단호박', '애호박', '늙은호박'] },
  { key: 'onion',    label: '양파', emoji: '🧅', keywords: ['양파'] },
  { key: 'mushroom', label: '버섯', emoji: '🍄', keywords: ['버섯', '표고', '느타리', '새송이', '팽이'] },
  { key: 'rice',     label: '쌀', emoji: '🍚', keywords: ['쌀', '백미', '현미', '찹쌀'] },
  { key: 'sesame',   label: '참깨', emoji: '🌱', keywords: ['참깨', '들깨', '참기름', '들기름', '깨'] },
];

// 흔히 먼저 등록하는 항목 (등록 UI 상단 노출용)
export const COMMON_KEYS = ['egg', 'milk', 'beef', 'chicken', 'soy', 'wheat', 'fish', 'shrimp', 'peach', 'tomato'];

const BY_KEY: Record<string, Allergen> = Object.fromEntries(ALLERGENS.map(a => [a.key, a]));

export function allergenByKey(key: string): Allergen | undefined {
  return BY_KEY[key];
}

// 재료 텍스트에서 선택된 알레르기(keys)에 해당하는 알레르겐을 찾아 반환.
// 반환: 걸린 알레르겐 목록 (중복 제거)
export function matchAllergens(ingredients: string, selectedKeys: string[]): Allergen[] {
  if (!ingredients || selectedKeys.length === 0) return [];
  // 재료를 공백 제거한 하나의 문자열로 (부분 일치 검사용)
  const hay = ingredients.replace(/\s+/g, '');
  const hits: Allergen[] = [];
  for (const key of selectedKeys) {
    const a = BY_KEY[key];
    if (!a) continue;
    if (a.keywords.some(kw => hay.includes(kw.replace(/\s+/g, '')))) {
      hits.push(a);
    }
  }
  return hits;
}

// 여러 재료 문자열(메뉴 여러 개)을 한 번에 검사해 걸린 알레르겐 키 집합 반환
export function matchAllergenKeys(ingredients: string, selectedKeys: string[]): string[] {
  return matchAllergens(ingredients, selectedKeys).map(a => a.key);
}
