import { STAGES, MENU_TYPES, type StageType, type MenuType } from './supabase';

/**
 * 카톡으로 받은 주문서 양식을 읽어 주문 입력칸을 채운다.
 *
 * 양식은 대략 이렇게 생겼다.
 *   ☆ 조리일 : 11/12
 *   ☆ 아기이름 : 김유건
 *   ☆ 개 월 수 : 8
 *   ☆ 주      소 : 강서구 공항대로53가길29 등촌파밀리에더클래식 201-403
 *   ☆ 현관비번 : 공동현관비번 버튼-> 0529-> 확인
 *   ☆ 연 락 처 : 01064318685
 *   ☆ 단계(종류) : 중기2-한우2,닭가슴살1,렌틸콩1
 *   ☆ 용 량 : 300g
 *
 * 손님이 손으로 고쳐 보내기 때문에 흐트러진다. 실제 주문서에서 겪은 것들:
 *   - 번호가 이모지(1️⃣)일 수도, ☆ 일 수도, 그냥 숫자일 수도 있다
 *   - 라벨 안에 띄어쓰기가 들어간다("개 월 수", "연 락 처")
 *   - 주소가 두 줄에 걸친다 (뒷줄엔 콜론이 없다)
 *   - 단계가 두 줄이다 — 한 사람이 후기와 완료기를 같이 시킨다
 *       ☆ 단계(종류) : 후기(한우2, 닭2, 가자미2)
 *                      완료기(한우1, 닭1)
 *   - 8번 줄에 안내문("ex(230g 또는 300g, 유아식은[반찬]으로기재")이 그대로 남고
 *     진짜 값은 그 뒤에 온다. 안내문에 '반찬' 글자가 있어서 그냥 읽으면
 *     전부 반찬 주문으로 잡힌다 — 안내문을 먼저 걷어내야 한다.
 *   - 주문서 아래에 메모가 붙는다("+30팩 추가결제", "현금영수증 발행 부탁드려요")
 *     이어붙이면 '30팩'을 수량으로 읽어버린다. 빈 줄에서 끊는다.
 *
 * 못 읽은 칸은 비워서 돌려준다. 멋대로 채우면 사장님이 틀린 걸 모르고 넘긴다.
 */

/** 단계·용량·메뉴가 한 묶음 — 한 사람이 여러 묶음을 시킬 수 있다 */
export type ParsedSet = {
  stage: StageType | '';
  volume: string;                  // '230' | '240' | '300' | '310'
  menus: Record<string, number>;   // 한우 / 닭 / 기타단백질
  qty: number;                     // 메뉴를 안 적었을 때의 팩수 (적었으면 메뉴 합)
};

export type ParsedKakaoOrder = {
  delivery_date: string;   // YYYY-MM-DD
  baby_name: string;
  months: string;
  address: string;
  door_password: string;
  customer_phone: string;
  stage: StageType | '';   // sets[0] — 예전 화면이 쓰던 칸
  volume: string;          // sets[0]
  isBanchan: boolean;
  sets: ParsedSet[];
};

export type ParseField = keyof ParsedKakaoOrder;

export const EMPTY_PARSED: ParsedKakaoOrder = {
  delivery_date: '', baby_name: '', months: '', address: '',
  door_password: '', customer_phone: '', stage: '', volume: '', isBanchan: false, sets: [],
};

const squash = (s: string) => s.replace(/\s+/g, '');

/** 콜론이 여러 개면 마지막 것 기준 — 안내문이 콜론을 하나 더 갖고 있다 */
function valueOf(line: string): string {
  const i = line.lastIndexOf(':');
  return i < 0 ? '' : line.slice(i + 1).trim();
}

/** 줄 앞의 번호(1️⃣, 1., ☆, ★)와 라벨만 남긴다 */
function labelOf(line: string): string {
  const i = line.indexOf(':');
  const head = i < 0 ? line : line.slice(0, i);
  return squash(head).replace(/[0-9️⃣.)\-★☆*]/g, '');
}

type FieldKey = '조리일' | '이름' | '개월수' | '주소' | '현관' | '연락처' | '단계' | '용량';

function labelKind(label: string): FieldKey | null {
  if (!label) return null;
  if (/조리일|배송일|날짜/.test(label)) return '조리일';
  if (/아기이름|아가이름|이름/.test(label)) return '이름';
  if (/개월수|월령/.test(label)) return '개월수';
  if (/주소/.test(label)) return '주소';
  if (/현관|비번/.test(label)) return '현관';
  if (/연락처|전화|번호/.test(label)) return '연락처';
  if (/단계|종류/.test(label)) return '단계';
  if (/용량/.test(label)) return '용량';
  return null;
}

function isValidDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, da] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, da));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === da;
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

/** "11월9일" · "11/12" · "2026.11.10" → YYYY-MM-DD */
function parseDate(raw: string, today: string): string {
  const v = squash(raw);
  const ymd = v.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (ymd) {
    const d = `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
    return isValidDate(d) ? d : '';
  }
  const md = v.match(/(\d{1,2})월\s*(\d{1,2})일?/) || v.match(/(\d{1,2})[./-](\d{1,2})/);
  if (!md) return '';
  const mo = Number(md[1]), da = Number(md[2]);
  if (!mo || !da || mo > 12 || da > 31) return '';
  const year = Number(today.slice(0, 4));
  const mk = (y: number) => `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  let out = mk(year);
  if (!isValidDate(out)) return '';
  // 한참 지난 날짜면 내년 것으로 본다 (12월에 1월 주문을 받는 경우)
  if (daysBetween(today, out) < -60) out = mk(year + 1);
  return isValidDate(out) ? out : '';
}

function parseMonths(raw: string): string {
  const m = squash(raw).match(/(\d{1,2})\s*개?월?/);
  return m ? String(Number(m[1])) : '';
}

/**
 * 8번 줄의 안내문을 걷어낸다.
 * "ex(230g 또는 300g,  유아식은[반찬]으로기재" 까지가 안내문이고 진짜 값은 그 뒤다.
 * 괄호가 안 닫혀 있는 경우가 많아서 "기재" 까지를 기준으로 자른다.
 */
function stripGuide(v: string): string {
  return v
    .replace(/ex\s*\(?[^)]*?기재\s*\)?/gi, ' ')
    .replace(/유아식은\s*\[?\s*반찬\s*\]?\s*으?로?\s*기?재?/g, ' ')
    .trim();
}

const VOLUMES = ['230', '240', '300', '310'];

function parseVolume(raw: string): { volume: string; isBanchan: boolean; qty: number } {
  const cleaned = stripGuide(raw);
  const v = squash(cleaned);
  const isBanchan = /반찬|유아식/.test(v);
  const found = (v.match(/\d{3}/g) || []).filter(x => VOLUMES.includes(x));
  const packs = cleaned.match(/(\d{1,2})\s*팩/);
  return {
    volume: found.length ? found[found.length - 1] : '',
    isBanchan,
    qty: packs ? Number(packs[1]) : 0,
  };
}

// 단계 토큰 — 긴 것부터 찾아야 "중기2단계"가 "중기"로 잘리지 않는다
const STAGE_TOKEN = /(중기\s*1\s*단계|중기\s*2\s*단계|중기\s*1|중기\s*2|완료기|완료|후기|초기|중기|반찬|유아식)/g;

function toStage(tok: string): StageType | '' | '반찬' {
  const v = squash(tok);
  if (/반찬|유아식/.test(v)) return '반찬';
  if (/중기1/.test(v)) return '중기1단계';
  if (/중기2/.test(v)) return '중기2단계';
  if (/완료/.test(v)) return '완료기';
  if (/후기/.test(v)) return '후기';
  if (/중기/.test(v)) return '중기1단계';
  return '';
}

/** 재료 이름 → 메뉴 종류. 한우·닭 말고는 전부 기타단백질이다 */
function toMenu(name: string): MenuType | null {
  const v = squash(name);
  if (!v) return null;
  if (/한우|소고기|쇠고기|우둔|설도|사태/.test(v)) return '한우';
  if (/닭/.test(v)) return '닭';
  // 수량 단위나 양식 글자는 재료가 아니다
  if (/^(팩|개|g|단계|종류|용량|총|합|월|일)$/.test(v)) return null;
  if (/^\d+$/.test(v)) return null;
  return '기타단백질';
}

/** "한우2, 닭가슴살1, 렌틸콩1" → {한우:2, 닭:1, 기타단백질:1} */
function parseMenus(seg: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of MENU_TYPES) out[m] = 0;
  let any = false;
  for (const hit of seg.matchAll(/([가-힣]{1,10})\s*(\d{1,2})\s*(?:팩|개)?/g)) {
    const menu = toMenu(hit[1]);
    const n = Number(hit[2]);
    if (!menu || !n) continue;
    out[menu] += n;
    any = true;
  }
  return any ? out : {};
}

/**
 * 메뉴를 안 적고 가짓수만 적는 분들이 있다 — "완료기 3가지(230g)".
 * 3가지는 3팩이라는 뜻이다. 무엇을 담을지는 모르니 팩수만 읽는다.
 */
function segQtyOf(seg: string): number {
  const m = seg.match(/(\d{1,2})\s*(?:팩|개|가지|종류)/);
  return m ? Number(m[1]) : 0;
}

/**
 * 단계 줄을 묶음으로 쪼갠다.
 *   "중기2-한우2,닭가슴살1,렌틸콩1"        → [중기2 {한우2,닭1,기타1}]
 *   "후기(한우2, 닭2, 가자미2) 완료기(한우1, 닭1)" → [후기 {...}, 완료기 {...}]
 *   "후기"                                  → [후기 {}]
 */
function parseStageSets(raw: string): { stage: StageType | ''; menus: Record<string, number>; banchan: boolean; qty: number }[] {
  const text = String(raw || '');
  const marks: { idx: number; len: number; tok: string }[] = [];
  STAGE_TOKEN.lastIndex = 0;
  for (const m of text.matchAll(STAGE_TOKEN)) {
    marks.push({ idx: m.index ?? 0, len: m[0].length, tok: m[0] });
  }
  if (!marks.length) return [];

  const out: { stage: StageType | ''; menus: Record<string, number>; banchan: boolean; qty: number }[] = [];
  for (let i = 0; i < marks.length; i++) {
    const seg = text.slice(marks[i].idx + marks[i].len, i + 1 < marks.length ? marks[i + 1].idx : undefined);
    const st = toStage(marks[i].tok);
    if (st === '반찬') { out.push({ stage: '', menus: {}, banchan: true, qty: 0 }); continue; }
    if (!st) continue;
    // 같은 단계가 두 번 잡히면(예: "중기" 와 "중기2" 가 겹칠 때) 뒤엣것에 합친다
    const prev = out.find(o => o.stage === st);
    const menus = parseMenus(seg);
    if (prev) {
      for (const k of Object.keys(menus)) prev.menus[k] = (prev.menus[k] || 0) + menus[k];
      prev.qty = prev.qty || segQtyOf(seg);
    } else {
      out.push({ stage: st, menus, banchan: false, qty: segQtyOf(seg) });
    }
  }
  return out;
}

export function parseKakaoOrder(text: string, today: string): ParsedKakaoOrder {
  const out: ParsedKakaoOrder = { ...EMPTY_PARSED, sets: [] };
  if (!text) return out;

  // 1) 줄을 칸으로 모은다. 콜론 없는 줄은 바로 앞 칸에 이어 붙이되,
  //    빈 줄을 만나면 끊는다 — 주문서 아래 메모("+30팩 추가결제")가 붙으면
  //    그 숫자를 수량으로 읽어버린다.
  const fields: { kind: FieldKey; value: string }[] = [];
  let joining = true;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { joining = false; continue; }
    const kind = line.includes(':') ? labelKind(labelOf(line)) : null;
    if (kind) {
      fields.push({ kind, value: valueOf(line) });
      joining = true;
    } else if (joining && fields.length) {
      fields[fields.length - 1].value += ' ' + line;
    }
  }

  const get = (k: FieldKey) => fields.filter(f => f.kind === k).map(f => f.value).join(' ').trim();

  out.delivery_date = parseDate(get('조리일'), today);
  out.baby_name = get('이름').slice(0, 20);
  out.months = parseMonths(get('개월수'));
  out.address = get('주소').replace(/\s+/g, ' ').slice(0, 200);
  out.door_password = get('현관').slice(0, 30);
  out.customer_phone = get('연락처').replace(/\D/g, '').slice(0, 11);

  const vol = parseVolume(get('용량'));
  const groups = parseStageSets(get('단계'));

  out.isBanchan = vol.isBanchan || groups.some(g => g.banchan);

  // 2) 단계 묶음마다 한 칸. 용량은 주문서에 하나만 적히므로 모든 묶음에 같이 쓴다.
  for (const g of groups) {
    if (g.banchan || !g.stage) continue;
    const menuSum = MENU_TYPES.reduce((a, m) => a + (g.menus[m] || 0), 0);
    out.sets.push({
      stage: g.stage,
      volume: vol.volume,
      menus: menuSum ? g.menus : {},
      // 메뉴를 안 적었으면 단계 줄의 팩수("완료기 3가지"), 그것도 없으면 용량 줄의 팩수("300g 3팩").
      // 용량 줄 팩수는 전체 합이라 묶음이 여럿이면 어느 쪽 것인지 알 수 없어 쓰지 않는다.
      qty: menuSum || g.qty || (groups.length === 1 ? vol.qty : 0),
    });
  }

  out.stage = out.sets[0]?.stage || '';
  out.volume = out.sets[0]?.volume || vol.volume;
  return out;
}

/** 아직 못 읽은 칸들 — 화면에 "이건 직접 넣어주세요" 로 띄운다. */
export function missingFields(p: ParsedKakaoOrder): ParseField[] {
  const need: ParseField[] = ['delivery_date', 'baby_name', 'months', 'address', 'customer_phone'];
  if (!p.isBanchan) need.push('stage', 'volume');
  return need.filter(k => !p[k]);
}

export const FIELD_LABEL: Record<ParseField, string> = {
  delivery_date: '조리일', baby_name: '아기 이름', months: '개월수', address: '주소',
  door_password: '현관 비번', customer_phone: '연락처', stage: '단계', volume: '용량',
  isBanchan: '반찬', sets: '단계 묶음',
};
