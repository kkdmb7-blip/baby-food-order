import { STAGES, STAGE_OPTIONS, MENU_TYPES } from './supabase';
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
const ALWAYS_IN = /^(한우|소고기|쇠고기|한우안심|닭|닭고기|닭안심|닭가슴살|닭육수|육수|채소상탕|상탕|채수|채소육수|양파|물|쌀|쌀가루)$/;

export function shortIngredients(raw: string): string {
  return String(raw || '')
    .split(/[,·/]|\s+/)
    .map(t => t.replace(/[()]/g, '').trim())
    .filter(t => t && !ALWAYS_IN.test(t))
    .join(' · ');
}

export type PersonRow = {
  orderId: string;
  phone: string;       // 화면에서 '고치기' 를 열 때 쓴다 (한 사람 = 한 연락처)
  name: string;
  pickup: boolean;     // 픽업(방문수령) — 조리는 하지만 배송차에 실으면 안 됨
  unspec: number;      // 메뉴가 지정 안 된 팩수 (이름에 붙이면 이름칸이 터진다)
  volume: number;
  isBig: boolean;
  menus: Record<string, number>;
  allergy: boolean;
  multi: boolean;      // 같은 사람의 줄이 또 있는지 (포장 시 합쳐야 한다)
  others: string[];    // 그 사람의 다른 줄들 — "+완료기 300g" 처럼 어디 있는지 적어준다
  isNew: boolean;      // 프린트한 뒤에 들어온 줄
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
  banchan: { name: string; qty: number; phone: string; others: string[]; menus: Record<string, number> }[];
  /** 반찬 종류별 합계 — 엑셀 '수반찬 주문내역' 맨 아랫줄과 같은 숫자다 */
  banchanByItem: { name: string; qty: number }[];
  banchanTotal: number;
  /** 그날 줄이 둘 이상인 사람 — 포장할 때 한 봉투로 합쳐야 한다 */
  multi: { name: string; parts: { label: string; qty: number }[]; total: number }[];
  allergies: { name: string; items: string[] }[];
  memos: { name: string; memo: string }[];
};

type OrderLike = {
  id: string; baby_name: string; customer_phone: string; items?: any;
  delivery_date: string; stage?: string | null; volume?: number | null; total_qty?: number;
  allergies?: string[] | null; memo?: string | null; receive_method?: string | null;
  created_at?: string;
};

/**
 * 한 단계에 사람이 몰리면(후기 24명 같은 날) 세로로 늘어져 A4 한 장을 넘어가고 블록이
 * 통째로 다음 장으로 밀린다. 열두 명마다 같은 단계를 여러 칸으로 나눠 옆으로 흐르게 한다.
 */
const CHUNK = 12;

export function buildCookingSheet(
  orders: OrderLike[], date: string, printedAt?: string | null,
): CookingSheet {
  const dispName = disambiguateNames(orders as any);
  const byStage = new Map<string, PersonRow[]>();
  const banchan: CookingSheet['banchan'] = [];

  for (const o of orders) {
    for (const s of slicesOn(o as any, date)) {
      if (s.stage === '반찬세트') {
        banchan.push({ name: o.baby_name, qty: s.qty, phone: o.customer_phone, others: [], menus: s.menus || {} });
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
        unspec,
        volume: Number(s.volume) || 0,
        isBig: Number(s.volume) === BIG_VOLUME[stage],
        menus,
        allergy: (o.allergies || []).length > 0,
        multi: false,
        others: [],
        isNew: !!(printedAt && o.created_at && o.created_at > printedAt),
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
  const label = (stage: string, volume: number) => `${stage} ${volume}g`;
  const byPerson = new Map<string, { name: string; parts: { label: string; qty: number }[] }>();
  const addPart = (phone: string, name: string, lbl: string, qty: number) => {
    const e = byPerson.get(phone) || { name, parts: [] };
    e.parts.push({ label: lbl, qty });
    byPerson.set(phone, e);
  };
  for (const [stage, list] of byStage) {
    for (const p of list) {
      addPart(p.phone, p.name, label(stage, p.volume),
        MENU_TYPES.reduce((a, m) => a + p.menus[m], 0) + p.unspec);
    }
  }
  for (const b of banchan) addPart(b.phone, b.name, '반찬 세트', b.qty);

  // 각 줄에 "그 사람의 다른 줄"을 적어준다 — 어디에 또 있는지 알면 찾아다니지 않는다
  const othersFor = (phone: string, mine: string) => {
    const parts = byPerson.get(phone)?.parts || [];
    const out: string[] = [];
    let skipped = false;
    for (const t of parts) {
      if (!skipped && t.label === mine) { skipped = true; continue; }
      out.push(t.label);
    }
    return out;
  };
  for (const [stage, list] of byStage) {
    for (const p of list) {
      p.others = othersFor(p.phone, label(stage, p.volume));
      p.multi = p.others.length > 0;
    }
  }
  for (const b of banchan) b.others = othersFor(b.phone, '반찬 세트');

  // 같은 용량끼리 붙여두면 240g 먼저 쭉, 그다음 310g 쭉 챙길 수 있다
  for (const list of byStage.values()) {
    list.sort((a, b) => a.volume - b.volume || a.name.localeCompare(b.name));
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
    banchanTotal: banchan.reduce((s, b) => s + b.qty, 0),
    banchanByItem: (() => {
      // 손님마다 종류별 개수가 다르다(엑셀 '주문변경' 시트). 종류별로 모아야 몇 개를 만들지 안다.
      const m = new Map<string, number>();
      for (const b of banchan) for (const [k, v] of Object.entries(b.menus)) {
        if (v) m.set(k, (m.get(k) || 0) + v);
      }
      return [...m.entries()].map(([name, qty]) => ({ name, qty }));
    })(),
    multi: [...byPerson.values()]
      .filter(e => e.parts.length > 1)
      .map(e => ({
        name: e.name, parts: e.parts,
        total: e.parts.reduce((a, t) => a + t.qty, 0),
      })),
    allergies: orders
      .filter(o => (o.allergies || []).length > 0)
      .map(o => ({ name: dispName.get(o.id) || o.baby_name, items: o.allergies || [] })),
    memos: orders
      .filter(o => o.memo)
      .map(o => ({ name: dispName.get(o.id) || o.baby_name, memo: String(o.memo) })),
  };
}
