import { STAGES, STAGE_OPTIONS, MENU_TYPES, isBanchanStage, isBanchanSingle } from './supabase';
import { sortBanchanNames } from './banchanOrder';
import { slicesOn, disambiguateNames } from './orderItems';

/*
  조리표 한 장을 만드는 계산. 화면과 종이가 같은 값을 쓰게 하려고 여기 모아 둔다.

  왜 계산을 따로 떼어 두는가
    화면 조리표와 프린트 조리표가 서로 다른 코드로 그려지고 있었다. 화면 쪽은 단계·용량으로
    묶은 목록이었고, 종이 쪽은 단계별 블록 + 용량별 합계였다. 담는 사람이 보는 숫자가
    두 모양이면 어느 쪽을 믿어야 하는지 알 수 없다. 이제 둘 다 이 함수 하나를 쓴다.

  왜 단계별 블록인가
    조리는 "중기 다 챙기고 → 후기 다 챙기고" 순서로 한다. 사람을 한 줄에 놓고 단계를
    가로로 늘어놓으면 빈 칸 사이를 계속 왔다갔다 해야 한다. 엑셀에서도 블록마다
    한 단계씩 쓰고 계셨다.
*/

// 단계마다 용량이 2가지 — 큰 쪽(310/300)은 빨간색으로 구분 (기존 엑셀 조리표와 동일)
export const BIG_VOLUME: Record<string, number> = Object.fromEntries(
  STAGES.map(s => [s, Math.max(...STAGE_OPTIONS[s].map(o => o.volume))])
);
export const SMALL_VOLUME: Record<string, number> = Object.fromEntries(
  STAGES.map(s => [s, Math.min(...STAGE_OPTIONS[s].map(o => o.volume))])
);

/*
  조리표 위에 적는 '오늘 메뉴' 를 간결하게 만든다.

  재료 목록에는 늘 들어가는 것들이 그대로 붙어 있다 — 한우/닭(그 메뉴의 이름이니 중복),
  닭육수·채소상탕(육수), 양파. 조리실에서는 그게 아니라 '오늘 뭐가 다른지' 만 보면 된다.
  그래서 항상 들어가는 것은 지우고 남는 재료만 적는다.
*/
const ALWAYS_IN = /^(한우|소고기|쇠고기|한우안심|닭|닭고기|닭안심|닭가슴살|채소상탕|상탕|채수|양파|물|쌀|쌀가루)$/;

/**
 * 재료 목록에서 '오늘 뭐가 다른지' 만 남긴다.
 *  - 늘 들어가는 것(한우·닭·양파·채소상탕·쌀)과 육수 전부(한우육수·닭육수·소고기육수…)는 뺀다
 *  - 메뉴 이름에 이미 있는 재료도 뺀다 — '한우 콜리플라워' 옆에 '콜리플라워' 가 또 붙어
 *    "콜리플라워가 왜 두 번 적혔어" 가 됐다
 */
export function shortIngredients(raw: string, menuName = ''): string {
  const name = String(menuName || '').replace(/\s+/g, '');
  return String(raw || '')
    .split(/[,·/]|\s+/)
    .map(t => t.replace(/[()]/g, '').trim())
    .filter(t => t && !ALWAYS_IN.test(t) && !t.endsWith('육수') && !(name && name.includes(t)))
    .join(' · ');
}

export type PersonRow = {
  orderId: string;
  phone: string;       // 화면에서 '고치기' 를 열 때 쓴다 (한 사람 = 한 연락처)
  name: string;
  pickup: boolean;     // 픽업(방문수령) — 조리는 하지만 배송차에 실으면 안 됨
  /** 이름 옆 칸에 적는 받는 방법 — '픽' | '택' | '당' | '내' | '' (직배송은 기본이라 비워 둔다).
   *  '내' = 하루 보관했다가 다음 날 주문과 합쳐 택배 (월+화, 목+금).
   *  사장님: "이름 바로 옆 칸에 빈칸 하나씩 만들어서 픽업인지 택배인지 표기" */
  ship: string;
  unspec: number;      // 메뉴가 지정 안 된 팩수 (이름에 붙이면 이름칸이 터진다)
  volume: number;
  isBig: boolean;
  menus: Record<string, number>;
  multi: boolean;      // 같은 사람의 줄이 또 있는지 (포장 시 합쳐야 한다)
  /* 그 사람의 다른 줄들.
     ⚠️ 전에는 이걸 줄마다 통째로 적었다. 한 사람이 세 단계를 시키면 세 줄이 서로를
        다 적어서 표가 파란 글씨로 덮였다. 그다음엔 비고 칸에 '+N' 만 뒀는데,
        사장님이 "비고는 지우고 같은 사람이 다른 단계로 주문하면 이름 배경색으로, 여러 색을 써서"
        라고 하셔서 이제는 color 로 표시한다. others 는 '줄이 더 있나' 판정에만 쓴다. */
  others: string[];
  /** 줄이 둘 이상인 사람에게 주는 색 번호(0부터). 같은 사람은 블록이 달라도 같은 번호.
   *  한 줄뿐인 사람은 undefined. 화면이 이 번호로 이름 칸 배경색을 고른다. */
  color?: number;
  isNew: boolean;      // 프린트한 뒤에 들어온 줄
  createdAt?: string;  // 추가 줄끼리 들어온 순서로 놓으려고
  needInfo?: boolean;  // 연락처·주소를 아직 안 넣은 아이(이름·팩수만 먼저 넣음) — '정보?'
};

export type Section = {
  key: string;
  stage: string;
  list: PersonRow[];
  tot: Record<string, { small: number; big: number }>;
  total: number;       // 그 단계 전체 인원
  part: number;
  parts: number;
};

export type CookingSheet = {
  date: string;
  people: number;
  totalPacks: number;
  menuTotals: Record<string, number>;
  unspecTotal: number;
  sections: Section[];
  /** single=true 는 낱개(1~5개·픽업). qty 가 세트 수가 아니라 개수다 */
  banchan: { orderId: string; name: string; qty: number; phone: string; others: string[]; color?: number; menus: Record<string, number>; single?: boolean; ship: string; isNew?: boolean; createdAt?: string; needInfo?: boolean;
    /** 엑셀 반찬 시트 자리 — 1회(왼쪽) · 정기(오른쪽 위) · 오픈월드(그 아래) · 메뉴변경(뒷장). note = 메뉴변경 줄의 비고(정기·오픈월드) */
    group: BanchanGroup; note?: string }[];
  /** 반찬 종류별 합계 — 엑셀 '수반찬 주문내역' 맨 아랫줄과 같은 숫자다 */
  banchanByItem: { name: string; qty: number }[];
  /** 세트 수 합 (낱개는 안 섞는다 — 단위가 다르다) */
  banchanTotal: number;
  /** 낱개 개수 합 (1~5개·픽업) */
  banchanSingleTotal: number;
  // '합쳐 담기' 목록(multi)은 뺐다 — 사장님이 그 칸을 없애자고 하셨다. 줄의 비고 '+N' 만 남는다.
  // 알레르기 목록은 조리표에서 뺐다 — 사장님: "우린 앞으로 알레르기는 관여 안 해, 엄마가 알아서 빼야 한다"
  memos: { name: string; memo: string }[];
};

type OrderLike = {
  id: string; baby_name: string; customer_phone: string; items?: any;
  delivery_date: string; stage?: string | null; volume?: number | null; total_qty?: number;
  allergies?: string[] | null; memo?: string | null; receive_method?: string | null;
  delivery_method?: string | null;
  created_at?: string;
  address?: string | null;
  source?: string | null;
  order_type?: string | null;
  paid_note?: string | null;
  customer_id?: string | null;
};

/* 반찬 자리 — 사장님 엑셀 '수반찬 주문내역' 그대로 (2026-11-14 "엑셀 파일에는 다 이유가 있어")
     주문 시트 왼쪽 = 1회 주문, 오른쪽 위 = 정기배송, 그 아래 = 오픈월드, 뒷장(주문변경 시트) = 세트 그대로가 아닌 아이(메뉴 변경·낱개).
     이름표 시트도 같은 순서로 칸을 채운다. 조리표·입금 표·종이·이름표가 모두 이 함수 하나로 나눈다.
     정기 = 정기 주문(order_type) 이거나 손님 카드 '반찬 정기'(banchan_regular). 오픈월드 = 주문 표시나 엑셀 비고. */
export const BANCHAN_GROUPS = ['1회', '정기', '오픈월드', '메뉴변경'] as const;
/** 손님 카드 목록에서 '반찬 정기' 판정 함수를 만든다 — 주문의 카드(customer_id)나 연락처로 찾는다 */
export function banchanRegularMatcher(customers: { id: string; phone?: string | null; banchan_regular?: boolean | null }[]) {
  const ids = new Set<string>(), phones = new Set<string>();
  for (const c of customers) if (c.banchan_regular) { ids.add(c.id); if (c.phone) phones.add(c.phone); }
  return (o: { customer_id?: string | null; customer_phone?: string | null }) =>
    (!!o.customer_id && ids.has(o.customer_id)) || (!!o.customer_phone && phones.has(o.customer_phone));
}
export type BanchanGroup = typeof BANCHAN_GROUPS[number];
export function banchanGroupsOf(
  rows: { orderId: string; qty: number; menus: Record<string, number>; single?: boolean }[],
  orderOf: (id: string) => OrderLike | undefined,
  isRegular?: (o: OrderLike) => boolean,
): Map<string, { group: BanchanGroup; note?: string }> {
  // 그날 세트 메뉴(모든 세트 주문에 나온 반찬) — 이것을 세트 수만큼 똑같이 받으면 '세트 그대로'
  const items = new Set<string>();
  for (const r of rows) if (!r.single) for (const [k, v] of Object.entries(r.menus || {})) if (v) items.add(k);
  const out = new Map<string, { group: BanchanGroup; note?: string }>();
  for (const r of rows) {
    const o = orderOf(r.orderId);
    const ow = !!o && (String(o.paid_note || '').startsWith('오픈월드') || /오픈월드/.test(String(o.memo || '')));
    const reg = !!o && (o.order_type === '정기' || !!isRegular?.(o));
    const m = r.menus || {};
    const plain = !r.single && (Object.values(m).every(v => !v) || [...items].every(k => (m[k] || 0) === r.qty));
    if (!plain) out.set(r.orderId, { group: '메뉴변경', note: ow ? '오픈월드' : reg ? '정기' : r.single ? '낱개' : undefined });
    else out.set(r.orderId, { group: ow ? '오픈월드' : reg ? '정기' : '1회' });
  }
  return out;
}

/** 받는 방법을 종이에 적을 한 글자로 — 픽(픽업) · 택(택배) · 당(두발 당일배송).
 *  직배송(강서·양천 자체배송)이 기본이라 그건 비워 둔다.
 *  사장님: "한 글자로 표기해도 돼, 픽과 택" — 두 글자는 22px 칸에서 '택/배' 로 접혔다. */
export function shipTag(o: { receive_method?: string | null; delivery_method?: string | null; memo?: string | null }): string {
  if (o.receive_method === '픽업') return '픽';
  // 내 = 월+화·목+금 주문을 하루 보관했다가 다음 날 것과 합쳐 택배로 보낸다(사장님 엑셀 표시 '내').
  // 메모에 "엑셀 표시 '내'" 또는 "내일 합쳐" 가 있으면 그렇게 본다.
  if (/엑셀 표시 '내'|내일\s*합/.test(String(o.memo || ''))) return '내';
  const d = String(o.delivery_method || '');
  if (d.includes('택배')) return '택';
  if (d.includes('당일')) return '당';
  return '';
}

/**
 * 한 단계에 사람이 몰리면(후기 24명 같은 날) 세로로 늘어져 A4 한 장을 넘어가고 블록이
 * 통째로 다음 장으로 밀린다. 일정 인원마다 같은 단계를 여러 칸으로 나눠 옆으로 흐르게 한다.
 *
 * 20명인 이유 — 실제 인쇄 페이지를 PDF 로 뽑아 재 보니(2026-11-12, 77명) 22명짜리 블록이
 * 615~631px 이었다. A4 가로는 여백 빼고 세로 688px 인데 페이지 머리 ~60px 과 아래
 * '합쳐 담기' 상자가 들어가야 하니 블록은 ~560px 안이어야 한다. 줄 하나 ~20px(글씨 13px·
 * 위아래 2px), 블록 머리 ~44px, 합계 두 줄 ~40px 이면 20줄 = 484px 로 여유가 남는다.
 * 가로는 블록 168px 짜리 여섯 개(1048px)가 1062px 에 들어간다 — 5·10·20·30명이면
 * 1+1+2+2 = 여섯 블록이라 딱 한 장이다. 그보다 많으면 둘째 줄(다음 장)로 흐른다.
 * '다른 칸' 표시를 이름 밑이 아니라 오른쪽 비고 칸으로 옮겨서 줄 높이가 늘 한 줄로
 * 고정된 덕에 이 계산이 선다 (전에는 두 줄짜리 이름이 섞여 12명이 한계였다).
 */
const CHUNK = 20;

export function buildCookingSheet(
  orders: OrderLike[], date: string, printedAt?: string | null,
  opts?: { isBanchanRegular?: (o: OrderLike) => boolean },
): CookingSheet {
  const dispName = disambiguateNames(orders as any);
  /* '추가' = 조리표를 뽑은 뒤 들어온 줄. 뽑은 기록이 없는 날(엑셀 시절·안 뽑은 날)은 그날 오전 7시 뒤에 넣은 줄.
     2026-11-14 사장님: 11/2 에 나중에 넣은 고윤서가 맨 위에 있었다 — 그날은 뽑은 기록이 없어서 ㄱㄴ순에 섞였다.
     엑셀에서 옮긴 주문은 created_at 이 그날 0시(UTC)로 찍혀 있어 '추가'가 아니다. */
  const cutoff = Date.parse(printedAt || `${date}T07:00:00+09:00`);
  const isNewOrder = (o: OrderLike) => !!o.created_at && !String(o.source || '').startsWith('엑셀') && Date.parse(o.created_at) > cutoff;
  const needInfo = (o: OrderLike) => !String(o.address || '').trim() && o.receive_method !== '픽업';
  const byStage = new Map<string, PersonRow[]>();
  const banchan: CookingSheet['banchan'] = [];

  for (const o of orders) {
    for (const s of slicesOn(o as any, date)) {
      // 낱개(1~5개·픽업)도 만들어야 하는 반찬이다. 세트만 잡으면 조리표에서 통째로 빠진다.
      if (isBanchanStage(s.stage)) {
        banchan.push({
          orderId: o.id, name: o.baby_name, qty: s.qty, phone: o.customer_phone, others: [],
          menus: s.menus || {}, single: isBanchanSingle(s.stage), ship: shipTag(o),
          isNew: isNewOrder(o), createdAt: o.created_at, needInfo: needInfo(o), group: '1회',
        });
        continue;
      }
      const stage = String(s.stage || '');
      if (!STAGES.includes(stage as any)) continue;
      const menus: Record<string, number> = {};
      let has = false;
      for (const m of MENU_TYPES) { menus[m] = s.menus[m] || 0; if (menus[m]) has = true; }
      const unspec = Math.max(0, s.qty - MENU_TYPES.reduce((a, m) => a + menus[m], 0));
      if (!has && !unspec) continue;
      if (!byStage.has(stage)) byStage.set(stage, []);
      byStage.get(stage)!.push({
        orderId: o.id,
        phone: o.customer_phone,
        name: dispName.get(o.id) || o.baby_name,
        pickup: o.receive_method === '픽업',
        ship: shipTag(o),
        unspec,
        volume: Number(s.volume) || 0,
        isBig: Number(s.volume) === BIG_VOLUME[stage],
        menus,
        multi: false,
        others: [],
        isNew: isNewOrder(o),
        createdAt: o.created_at,
        needInfo: needInfo(o),
      });
    }
  }

  /* ⚠️ 한 사람이 후기+완료기, 중기2 230+300 처럼 여러 줄을 시키는 경우가 있다.
        단계별 블록으로 나눠 놓으면 같은 사람이 여러 블록에 흩어져서, 표시가 없으면
        포장할 때 각각 다른 손님으로 보고 따로 담게 된다.

        ⚠️ 전에는 이걸 '한 주문(orderId) 안에 단계가 둘 이상' 으로 찾았다. 주문접수가
        칸마다 주문 한 건을 만들게 된 뒤로는 같은 사람의 후기와 완료기가 서로 다른
        주문이라, 이 표시가 아예 뜨지 않았다. 사람(연락처) 단위로 찾는다.
        같은 단계 다른 용량(230+300)도 두 줄이므로 같이 잡는다 — 담을 때는 똑같이 합쳐야 한다. */
  /* 사람 = 연락처 + 아기 이름.
        ⚠️ 연락처만으로 묶었더니 같은 번호를 쓰는 다른 아이(형제, 또는 시험용으로 한 번호에
           여러 이름)가 한 사람으로 합쳐져 "이수근만 넣었는데 오찬희도 붙었다" 가 됐다.
           사장님: "전화번호가 같다고 해서 합치지는 말고, 그건 내가 따로 체크할게."
           그래서 이름이 다르면 다른 사람이다. 주문접수가 칸마다 주문 한 건을 만드는데
           그 건들은 이름·연락처가 같으니 같은 사람으로 잘 묶인다. */
  // '중기2 230' 처럼 짧게 — '합쳐 담기' 상자가 길어지면 A4 아래로 밀려 두 장이 된다
  const label = (stage: string, volume: number) => `${stage.replace('단계', '')} ${volume}`;
  type Part = { label: string; qty: number; name: string };
  const personKey = (phone: string, name: string) => `${phone}|${name}`;
  const byPerson = new Map<string, { name: string; parts: Part[] }>();
  const addPart = (phone: string, name: string, lbl: string, qty: number) => {
    const k = personKey(phone, name);
    const e = byPerson.get(k) || { name, parts: [] };
    e.parts.push({ label: lbl, qty, name });
    byPerson.set(k, e);
  };
  for (const [stage, list] of byStage) {
    for (const p of list) {
      addPart(p.phone, p.name, label(stage, p.volume),
        MENU_TYPES.reduce((a, m) => a + p.menus[m], 0) + p.unspec);
    }
  }
  // 낱개는 '세트 N개' 가 아니라 '반찬 N개' 다 — 합쳐 담을 때 숫자를 헷갈리면 안 된다
  const banchanLabel = (b: { single?: boolean }) => (b.single ? '반찬 낱개' : '반찬 세트');
  for (const b of banchan) addPart(b.phone, b.name, banchanLabel(b), b.qty);

  // 각 줄에 "그 사람의 다른 줄"을 뽑아 둔다 (줄의 비고 칸에는 개수만, 자세한 건 '합쳐 담기' 상자에)
  const othersFor = (phone: string, name: string, mine: string) => {
    const parts = byPerson.get(personKey(phone, name))?.parts || [];
    const out: string[] = [];
    let skipped = false;
    for (const t of parts) {
      // 내 줄 하나만 건너뛴다 (같은 칸이 두 줄일 수 있다)
      if (!skipped && t.label === mine) { skipped = true; continue; }
      out.push(t.label);
    }
    return out;
  };
  for (const [stage, list] of byStage) {
    for (const p of list) {
      p.others = othersFor(p.phone, p.name, label(stage, p.volume));
      p.multi = p.others.length > 0;
    }
  }
  for (const b of banchan) b.others = othersFor(b.phone, b.name, banchanLabel(b));

  /* 줄이 둘 이상인 사람마다 색 번호를 준다. 이름 ㄱㄴ순으로 매겨서 같은 날 같은 주문이면
     늘 같은 색이 나온다(새로고침마다 바뀌면 종이와 화면이 어긋난다). 색 자체는 화면이 고른다. */
  const colorOf = new Map<string, number>();
  [...byPerson.entries()]
    .filter(([, e]) => e.parts.length > 1)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name, 'ko'))
    .forEach(([k], i) => colorOf.set(k, i));
  for (const list of byStage.values()) for (const p of list) p.color = colorOf.get(personKey(p.phone, p.name));
  for (const b of banchan) b.color = colorOf.get(personKey(b.phone, b.name));

  /* 이름 ㄱㄴ순. 용량(230/300)으로 나누지 않고 섞는다.
     사장님: "나중에 찾기 편하게 나는 ㄱㄴ순으로 이름을 정렬했었고, 230과 300은 상관없이
     같은 단계면 그냥 섞어서 적었어. 그러면 같은 단계 다른 용량의 아가들은 이름이 바로 붙겠지."
     전에는 용량 먼저 정렬해서 240g 을 쭉 챙기고 310g 을 쭉 챙기는 흐름이었는데,
     그러면 한 아이의 230·300 이 멀리 떨어진다. 큰 용량은 빨간 숫자로 구분된다. */
  // 단, 프린트한 뒤에 들어온 줄('추가')은 ㄱㄴ순에 끼우지 않고 맨 아래에 들어온 순서대로 —
  // 사장님 2026-11-14: "추가한 아이들은 ㄱㄴ순 말고 그냥 맨 아래" (종이에 손으로 적은 것도 맨 아래라 대조가 쉽다)
  for (const list of byStage.values()) {
    list.sort((a, b) => Number(a.isNew) - Number(b.isNew)
      || (a.isNew ? String(a.createdAt || '').localeCompare(String(b.createdAt || '')) : 0)
      || a.name.localeCompare(b.name, 'ko') || a.volume - b.volume);
  }
  {
    // 반찬 자리 나누기(1회·정기·오픈월드·메뉴변경) → 자리마다 이름 ㄱㄴ순, 나중에 넣은 아이는 그 자리 맨 아래
    const byId = new Map(orders.map(o => [o.id, o]));
    const g = banchanGroupsOf(banchan, id => byId.get(id), opts?.isBanchanRegular);
    for (const b of banchan) { const x = g.get(b.orderId); if (x) { b.group = x.group; b.note = x.note; } }
    banchan.sort((x, y) => BANCHAN_GROUPS.indexOf(x.group) - BANCHAN_GROUPS.indexOf(y.group)
      || Number(!!x.isNew) - Number(!!y.isNew)
      || (x.isNew ? String(x.createdAt || '').localeCompare(String(y.createdAt || '')) : x.name.localeCompare(y.name, 'ko')));
  }

  const sections: Section[] = STAGES.filter(s => (byStage.get(s) || []).length > 0).flatMap(stage => {
    const list = byStage.get(stage)!;
    const tot: Record<string, { small: number; big: number }> = {};
    for (const m of MENU_TYPES) tot[m] = { small: 0, big: 0 };
    for (const p of list) for (const m of MENU_TYPES) {
      if (p.isBig) tot[m].big += p.menus[m]; else tot[m].small += p.menus[m];
    }
    const n = Math.ceil(list.length / CHUNK);
    return Array.from({ length: n }, (_, i) => ({
      key: `${stage}#${i}`, stage, list: list.slice(i * CHUNK, (i + 1) * CHUNK),
      tot, total: list.length, part: i + 1, parts: n,
    }));
  });

  // 같은 단계가 여러 칸으로 나뉘어도 합계는 한 번만 센다(칸마다 tot 이 같은 객체다)
  const menuTotals: Record<string, number> = {};
  for (const m of MENU_TYPES) menuTotals[m] = 0;
  for (const sec of sections.filter(s => s.part === 1)) {
    for (const m of MENU_TYPES) menuTotals[m] += sec.tot[m].small + sec.tot[m].big;
  }
  const named = MENU_TYPES.reduce((a, m) => a + menuTotals[m], 0);
  // 메뉴를 안 적은 팩도 만들어야 하는 팩이다 — 합계에서 빠지면 그만큼 모자란다
  const unspecTotal = sections
    .filter(s => s.part === 1)
    .reduce((a, sec) => a + (byStage.get(sec.stage) || []).reduce((b, p) => b + p.unspec, 0), 0);

  return {
    date,
    people: orders.length,
    totalPacks: named + unspecTotal,
    menuTotals,
    unspecTotal,
    sections,
    banchan,
    // 세트 수와 낱개 개수는 단위가 달라 한 숫자로 더하면 뜻이 없어진다
    banchanTotal: banchan.filter(b => !b.single).reduce((s, b) => s + b.qty, 0),
    banchanSingleTotal: banchan.filter(b => b.single).reduce((s, b) => s + b.qty, 0),
    banchanByItem: (() => {
      // 손님마다 종류별 개수가 다르다(엑셀 '주문변경' 시트). 종류별로 모아야 몇 개를 만들지 안다.
      const m = new Map<string, number>();
      for (const b of banchan) for (const [k, v] of Object.entries(b.menus)) {
        if (v) m.set(k, (m.get(k) || 0) + v);
      }
      // 손님 메뉴표와 같은 번호 순서로 (lib/banchanOrder) — 국은 맨 뒤
      return sortBanchanNames([...m.entries()].map(([name, qty]) => ({ name, qty })));
    })(),
    // 엑셀에서 옮길 때 남긴 자리 표시('주문변경 시트'·'비고 오픈월드'·'내')는 이제 표 자리·배송 칸으로 보이니 메모에선 뺀다
    memos: orders
      .map(o => ({ name: dispName.get(o.id) || o.baby_name,
        memo: String(o.memo || '').split(' · ').map(s => s.trim())
          .filter(s => s && !/^엑셀 주문변경 시트$|^엑셀 비고 '오픈월드'$|^엑셀 표시 '내'$/.test(s)).join(' · ') }))
      .filter(m => m.memo),
  };
}
