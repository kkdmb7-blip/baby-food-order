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
  multi: boolean;      // 같은 사람이 다른 단계도 주문했는지 (포장 시 합쳐야 한다)
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
  banchan: { name: string; qty: number; phone: string }[];
  banchanTotal: number;
  multi: { name: string; stages: string[] }[];
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
        banchan.push({ name: o.baby_name, qty: s.qty, phone: o.customer_phone });
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
        isNew: !!(printedAt && o.created_at && o.created_at > printedAt),
      });
    }
  }

  // ⚠️ 한 사람이 중기1+중기2, 중기+완료기처럼 여러 단계를 같이 시키는 경우가 있다.
  // 단계별 블록으로 나눠 놓으면 같은 사람이 여러 블록에 흩어져서, 표시가 없으면
  // 포장할 때 각각 다른 손님으로 보고 따로 담게 된다 — 합쳐야 한다는 표시를 남긴다.
  const stagesByOrder = new Map<string, string[]>();
  for (const [stage, list] of byStage) {
    for (const p of list) {
      const arr = stagesByOrder.get(p.orderId) || [];
      if (!arr.includes(stage)) arr.push(stage);
      stagesByOrder.set(p.orderId, arr);
    }
  }
  const multiIds = new Set([...stagesByOrder.entries()].filter(([, st]) => st.length > 1).map(([id]) => id));
  for (const list of byStage.values()) for (const p of list) p.multi = multiIds.has(p.orderId);

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

  const nameOf = (id: string) =>
    dispName.get(id) || orders.find(o => o.id === id)?.baby_name || '';

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
    multi: [...stagesByOrder.entries()]
      .filter(([, st]) => st.length > 1)
      .map(([id, st]) => ({ name: nameOf(id), stages: st })),
    allergies: orders
      .filter(o => (o.allergies || []).length > 0)
      .map(o => ({ name: dispName.get(o.id) || o.baby_name, items: o.allergies || [] })),
    memos: orders
      .filter(o => o.memo)
      .map(o => ({ name: dispName.get(o.id) || o.baby_name, memo: String(o.memo) })),
  };
}
