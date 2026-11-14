import type { SupabaseClient } from '@supabase/supabase-js';

/*
  여러 단계 선결제 — 2026-11-14 사장님: "후기230 이랑 완료기230 두 개 해두고 같이 주문하는 아이들도 있어"

  선결제 값은 중기·후기가 같고 완료기만 다르다(할인표 4종) → 묶음도 그 4종으로 나눈다.
    중기·후기 230g · 중기·후기 300g · 완료기 230g · 완료기 300g   (중기1 의 240/310 은 230/300 으로)

  저장
    prepaid_split = null          → 한 묶음 (예전 그대로: prepaid_balance + prepaid_label)
    prepaid_split = [{kind,balance}, …]  → 여러 묶음. prepaid_balance 는 늘 그 합.
  다른 종류로 충전하면 한 묶음 → 여러 묶음이 되고, 묶음이 다 떨어져 하나만 남으면 다시 한 묶음으로 접는다.

  잔액이 바뀌는 곳은 전부 movePrepaid 하나로 — 주문 선결제 차감, 취소 환불, 조리표 팩수 고치기,
  입금 탭 빼기·되돌리기·한꺼번에, 충전, 잔여 고치기. 한 곳만 고치면 묶음이 어긋난다.
  (반찬 회수 prepaid_banchan 은 따로 — 여기서 다루지 않는다)
*/

export const PREPAID_KINDS = ['중기·후기 230g', '중기·후기 300g', '완료기 230g', '완료기 300g'] as const;
export type Part = { kind: string; balance: number };

/** 주문의 단계·용량 → 선결제 묶음 이름. 반찬·모름은 null */
export function kindOf(stage?: string | null, volume?: number | string | null): string | null {
  const st = String(stage || '');
  if (!st || st.startsWith('반찬')) return null;
  if (!/^(중기|후기|완료)/.test(st)) return null;
  return `${st.startsWith('완료') ? '완료기' : '중기·후기'} ${Number(volume) >= 300 ? 300 : 230}g`;
}

/** 손님 카드의 라벨('후기 300g', '완료기 230g', '중기·후기 230g') → 묶음 이름 */
export function kindOfLabel(label?: string | null): string | null {
  const s = String(label || '');
  const v = s.match(/(\d{3})/);
  if (!v) return null;
  if (/완료/.test(s)) return `완료기 ${Number(v[1]) >= 300 ? 300 : 230}g`;
  if (/중기|후기/.test(s)) return `중기·후기 ${Number(v[1]) >= 300 ? 300 : 230}g`;
  return null;
}

/** 짧게 — 화면 꼬리표용 ('중기·후기 230g' → '중후230', '완료기 300g' → '완300') */
export const shortKind = (k: string) => k.replace('중기·후기 ', '중후').replace('완료기 ', '완').replace('g', '');

type C = { prepaid_balance?: number | null; prepaid_label?: string | null; prepaid_split?: Part[] | null };
export const isSplit = (c?: C | null) => !!c && Array.isArray(c.prepaid_split) && c.prepaid_split.length > 1;

/** 화면용 — 묶음 목록. 한 묶음이면 [{라벨 묶음, 전체}] */
export function partsOf(c?: C | null): Part[] {
  if (!c) return [];
  if (isSplit(c)) return (c.prepaid_split as Part[]).map(p => ({ kind: p.kind, balance: Number(p.balance) || 0 }));
  const bal = Number(c.prepaid_balance) || 0;
  return [{ kind: kindOfLabel(c.prepaid_label) || c.prepaid_label || '선결제', balance: bal }];
}

/** 이 주문(단계·용량)에 쓸 묶음의 잔액. 한 묶음 손님은 전체 잔액 */
export function balanceFor(c: C | null | undefined, kind: string | null): number {
  if (!c) return 0;
  if (!isSplit(c)) return Number(c.prepaid_balance) || 0;
  return (c.prepaid_split as Part[]).find(p => p.kind === kind)?.balance ?? 0;
}

export type MoveResult =
  | { ok: true; customerId: string; phone: string | null; babyName: string | null; before: number; after: number;
      kind: string | null; partBefore: number; partAfter: number; split: Part[] | null }
  | { ok: false; error: string; status: number };

/**
 * 선결제 팩을 옮긴다. 셋 중 하나:
 *   { delta }          더하기/빼기 (주문 차감 −, 환불 +)
 *   { set }            그 묶음 잔액을 이 숫자로 (사장님이 고침)
 *   { delta, charge }  충전 — 다른 종류면 묶음을 새로 만든다(한 묶음 → 여러 묶음)
 * kind = 이 팩이 속한 묶음(주문의 단계·용량이나 충전 종류). 한 묶음 손님은 kind 와 상관없이 전체에서 움직인다(예전 그대로).
 * expectPart: 그 묶음이 이 값일 때만 (두 번 눌림 방지). requireEnough: 모자라면 거절.
 * 읽은 전체 잔액 그대로일 때만 쓴다(CAS) — 그 사이 바뀌었으면 세 번까지 다시 읽는다.
 */
export async function movePrepaid(sb: SupabaseClient, customerId: string, op: {
  delta?: number; set?: number; charge?: boolean; kind?: string | null; expectPart?: number; requireEnough?: boolean;
}): Promise<MoveResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: c, error: e0 } = await sb.from('baby_food_customers')
      .select('id, phone, baby_name, prepaid_balance, prepaid_label, prepaid_split').eq('id', customerId).maybeSingle();
    if (e0) return { ok: false, error: e0.message, status: 500 };
    if (!c) return { ok: false, error: '손님 카드를 못 찾았어요', status: 404 };
    const total = Number(c.prepaid_balance) || 0;
    const kind = op.kind || null;

    let parts: Part[] | null = isSplit(c) ? (c.prepaid_split as Part[]).map(p => ({ kind: p.kind, balance: Number(p.balance) || 0 })) : null;
    let label: string | null | undefined; // undefined = 그대로
    // 한 묶음 손님이 다른 종류로 충전 → 여러 묶음으로 나눈다 (지금 잔액이 0 이면 그냥 종류만 바꾼다)
    const curKind = kindOfLabel(c.prepaid_label) || c.prepaid_label || null;
    if (!parts && op.charge && kind && total !== 0 && curKind && curKind !== kind) {
      parts = [{ kind: curKind, balance: total }];
    }

    let partBefore: number, partAfter: number, useKind: string | null;
    if (parts) {
      // 어느 묶음인지 — 주어진 종류, 없으면(단계 모름) 가장 많이 남은 묶음
      useKind = kind || [...parts].sort((a, b) => b.balance - a.balance)[0].kind;
      let p = parts.find(x => x.kind === useKind);
      if (!p) { p = { kind: useKind, balance: 0 }; parts.push(p); }
      partBefore = p.balance;
      partAfter = op.set !== undefined ? op.set : partBefore + (op.delta || 0);
      p.balance = partAfter;
      if (op.charge) label = useKind;
    } else {
      useKind = kind;
      partBefore = total;
      partAfter = op.set !== undefined ? op.set : total + (op.delta || 0);
      if (op.charge && kind) label = kind;
    }
    if (op.expectPart !== undefined && partBefore !== op.expectPart) return { ok: false, error: '잔액이 그 사이 바뀌었어요 — 새로고침 후 다시', status: 409 };
    if (op.requireEnough && (op.delta || 0) < 0 && partAfter < 0)
      return { ok: false, error: `${parts ? `${useKind} ` : ''}잔여 ${partBefore}팩 — ${-(op.delta || 0)}팩이 필요해요`, status: 400 };

    // 0 이 된 묶음은 접고, 하나만 남으면 한 묶음으로 되돌린다
    let split: Part[] | null = null;
    let next = partAfter;
    if (parts) {
      const live = parts.filter(x => x.balance !== 0);
      next = parts.reduce((s, x) => s + x.balance, 0);
      if (live.length >= 2) split = live;
      else { split = null; if (live.length === 1) label = live[0].kind; }
    }
    const patch: Record<string, any> = { prepaid_balance: next, prepaid_split: split };
    if (label !== undefined) patch.prepaid_label = label;
    const { data: up, error } = await sb.from('baby_food_customers').update(patch)
      .eq('id', c.id).eq('prepaid_balance', total).select('id');
    if (error) return { ok: false, error: error.message, status: 500 };
    if (up && up.length) {
      return { ok: true, customerId: c.id, phone: c.phone, babyName: c.baby_name, before: total, after: next,
        kind: parts ? useKind : null, partBefore, partAfter, split };
    }
  }
  return { ok: false, error: '잔액이 계속 바뀌어요 — 새로고침 후 다시', status: 409 };
}

/* 한 주문 안에 용량이 섞여 들어온다 — 2026-11-14 사장님(서은혁): "후기230이랑 300이랑 같이 시키는데 합쳐서 빠지는 것 같아"
   주문 행의 volume 은 하나뿐이라(첫 세트 용량) 그걸로만 보면 300g 3팩 + 230g 1팩이 전부 300g 묶음에서 빠졌다.
   세트(items[].sets[])의 단계·용량별 팩으로 나눈다. 세트 합이 total_qty 와 다르면(옛 주문·고친 주문) 예전처럼 한 묶음. */
type OrderLike = { stage?: string | null; volume?: number | string | null; total_qty?: number | null; items?: any };
export function orderKinds(o: OrderLike): { kind: string | null; qty: number }[] {
  const total = Number(o.total_qty) || 0;
  const m = new Map<string, number>();
  let sum = 0;
  for (const it of Array.isArray(o.items) ? o.items : []) {
    for (const s of Array.isArray(it?.sets) ? it.sets : []) {
      const k = kindOf(s?.stage || o.stage, s?.volume ?? o.volume);
      const q = Number(s?.qty) || 0;
      if (!k || q <= 0) continue;
      m.set(k, (m.get(k) || 0) + q); sum += q;
    }
  }
  if (!m.size || sum !== total) return [{ kind: kindOf(o.stage, o.volume), qty: total }];
  return [...m].map(([kind, qty]) => ({ kind, qty }));
}
/** 용량이 섞인 주문인가 */
export const isMixed = (o: OrderLike) => orderKinds(o).length > 1;

/**
 * 주문 하나의 팩을 묶음별로 한꺼번에 옮긴다 (용량 섞인 주문). 한 종류면 movePrepaid 그대로.
 * 한 묶음 손님은 예전처럼 전체에서. 여러 묶음 손님은 종류마다 그 묶음에서 — 한 번에 쓴다(CAS).
 * moved = 움직인 묶음들의 뒤 잔액 (여러 묶음 손님일 때만)
 */
export async function movePrepaidMany(sb: SupabaseClient, customerId: string, moves: { kind: string | null; delta: number }[], opt?: { requireEnough?: boolean }):
  Promise<MoveResult & { moved?: Part[] }> {
  if (moves.length <= 1) return movePrepaid(sb, customerId, { delta: moves[0]?.delta || 0, kind: moves[0]?.kind ?? null, requireEnough: opt?.requireEnough });
  const sum = moves.reduce((s, m) => s + m.delta, 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: c, error: e0 } = await sb.from('baby_food_customers')
      .select('id, phone, baby_name, prepaid_balance, prepaid_label, prepaid_split').eq('id', customerId).maybeSingle();
    if (e0) return { ok: false, error: e0.message, status: 500 };
    if (!c) return { ok: false, error: '손님 카드를 못 찾았어요', status: 404 };
    const total = Number(c.prepaid_balance) || 0;
    const patch: Record<string, any> = {};
    let next = total + sum, split: Part[] | null = null, moved: Part[] | undefined;
    // 한 묶음 손님도 종류를 알면 용량별로 센다 — 없는 용량은 마이너스(입금 요청)로 새 묶음이 생긴다.
    // 사장님 2026-11-14: "카운팅 자체를 2개로 나눠서 해야 돼". 종류를 모르는 옛 잔액(라벨 없음)만 예전처럼 합쳐서.
    const curKind = kindOfLabel(c.prepaid_label) || null;
    const canSplit = isSplit(c) || !!curKind || total === 0;
    if (canSplit) {
      const parts: Part[] = isSplit(c) ? (c.prepaid_split as Part[]).map(p => ({ kind: p.kind, balance: Number(p.balance) || 0 }))
        : total !== 0 ? [{ kind: curKind as string, balance: total }] : [];
      if (!parts.length && moves.some(m => !m.kind)) { parts.push({ kind: moves.find(m => m.kind)?.kind || PREPAID_KINDS[0], balance: 0 }); }
      for (const mv of moves) {
        const k = mv.kind || [...parts].sort((a, b) => b.balance - a.balance)[0].kind;
        let p = parts.find(x => x.kind === k);
        if (!p) { p = { kind: k, balance: 0 }; parts.push(p); }
        if (opt?.requireEnough && mv.delta < 0 && p.balance + mv.delta < 0)
          return { ok: false, error: `${k} 잔여 ${p.balance}팩 — ${-mv.delta}팩이 필요해요`, status: 400 };
        p.balance += mv.delta;
      }
      moved = moves.map(mv => parts.find(x => x.kind === mv.kind)).filter(Boolean).map(p => ({ ...(p as Part) }));
      next = parts.reduce((s, x) => s + x.balance, 0);
      const live = parts.filter(x => x.balance !== 0);
      if (live.length >= 2) split = live;
      else if (live.length === 1) patch.prepaid_label = live[0].kind;
    } else if (opt?.requireEnough && sum < 0 && next < 0) {
      return { ok: false, error: `잔여 ${total}팩 — ${-sum}팩이 필요해요`, status: 400 };
    }
    patch.prepaid_balance = next; patch.prepaid_split = split;
    const { data: up, error } = await sb.from('baby_food_customers').update(patch)
      .eq('id', c.id).eq('prepaid_balance', total).select('id');
    if (error) return { ok: false, error: error.message, status: 500 };
    if (up && up.length) {
      return { ok: true, customerId: c.id, phone: c.phone, babyName: c.baby_name, before: total, after: next,
        kind: moved ? moves.map(m => m.kind).join('+') : null, partBefore: total, partAfter: next, split, moved };
    }
  }
  return { ok: false, error: '잔액이 계속 바뀌어요 — 새로고침 후 다시', status: 409 };
}

/** 그 묶음 잔액 — 한 묶음 손님은 그 묶음 종류일 때만 전체, 다른 종류는 0 (한꺼번에 빼기 용량별에서 씀) */
export function partBalance(c: C | null | undefined, kind: string): number {
  if (!c) return 0;
  if (isSplit(c)) return (c.prepaid_split as Part[]).find(p => p.kind === kind)?.balance ?? 0;
  const total = Number(c.prepaid_balance) || 0;
  const cur = kindOfLabel(c.prepaid_label) || c.prepaid_label || null;
  return !cur || cur === kind ? total : 0;
}

/**
 * 여러 묶음 잔액을 한 번에 정한다 — 한꺼번에 빼기(용량별). 2026-11-14 사장님: "한꺼번에 빼기에도 나눠서 빼는 기능"
 * sets[i].expect = 읽어 둔 그 묶음 잔액(두 번 눌림·그 사이 바뀜 방지). 한 묶음 손님이면 나뉜다.
 */
export async function setPrepaidParts(sb: SupabaseClient, customerId: string, sets: { kind: string; set: number; expect?: number }[]):
  Promise<{ ok: true; before: number; after: number; split: Part[] | null } | { ok: false; error: string; status: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: c, error: e0 } = await sb.from('baby_food_customers')
      .select('id, prepaid_balance, prepaid_label, prepaid_split').eq('id', customerId).maybeSingle();
    if (e0) return { ok: false, error: e0.message, status: 500 };
    if (!c) return { ok: false, error: '손님 카드를 못 찾았어요', status: 404 };
    for (const s of sets) if (s.expect !== undefined && partBalance(c, s.kind) !== s.expect)
      return { ok: false, error: '잔액이 그 사이 바뀌었어요 — 새로고침 후 다시', status: 409 };
    const total = Number(c.prepaid_balance) || 0;
    const curKind = kindOfLabel(c.prepaid_label) || c.prepaid_label || null;
    const parts: Part[] = isSplit(c) ? (c.prepaid_split as Part[]).map(p => ({ kind: p.kind, balance: Number(p.balance) || 0 }))
      : total !== 0 ? [{ kind: curKind || sets[0].kind, balance: total }] : [];
    for (const s of sets) {
      const p = parts.find(x => x.kind === s.kind);
      if (p) p.balance = s.set; else parts.push({ kind: s.kind, balance: s.set });
    }
    const next = parts.reduce((s, x) => s + x.balance, 0);
    const live = parts.filter(x => x.balance !== 0);
    const patch: Record<string, any> = { prepaid_balance: next, prepaid_split: live.length >= 2 ? live : null };
    if (live.length === 1) patch.prepaid_label = live[0].kind;
    const { data: up, error } = await sb.from('baby_food_customers').update(patch).eq('id', c.id).eq('prepaid_balance', total).select('id');
    if (error) return { ok: false, error: error.message, status: 500 };
    if (up && up.length) return { ok: true, before: total, after: next, split: patch.prepaid_split };
  }
  return { ok: false, error: '잔액이 계속 바뀌어요 — 새로고침 후 다시', status: 409 };
}

/* 단계 변경(중기·후기 → 완료기) — 2026-11-14 사장님(안시은): "완료기로 바꾸고 싶으면 남은 팩만큼 차액을 추가 입금하면 해 줘.
   예: 24팩 남았으면 12,000원". 선결제 값은 완료기가 팩당 500원 더 비싸다(20·30·50팩 할인폭이 같아서 늘 500원).
   이 주문 묶음(to)이 없는데 같은 용량 중기·후기 묶음(from)이 남아 있으면 → 바꿔야 할 손님.
   종류 기록이 없는 옛 한 묶음(라벨 없음)은 중기·후기로 본다. */
export const CONVERT_PER_PACK = 500;
export function convertNeed(c: C | null | undefined, toKind: string | null): { from: string; to: string; fromBalance: number } | null {
  if (!c || !toKind || !toKind.startsWith('완료기')) return null;
  const from = toKind.replace('완료기', '중기·후기');
  if (isSplit(c)) {
    const parts = c.prepaid_split as Part[];
    if (parts.some(p => p.kind === toKind)) return null;
    const f = parts.find(p => p.kind === from);
    return f && Number(f.balance) !== 0 ? { from, to: toKind, fromBalance: Number(f.balance) } : null;
  }
  const total = Number(c.prepaid_balance) || 0;
  // 종류 기록이 없는 옛 카드는 서버가 붙여 준 짐작(처음 선결제로 빠진 주문의 종류)으로 본다 — 짐작도 없으면 표시 안 함
  // (라벨 없는 완료기 손님까지 '전환' 이 뜨던 것, 2026-11-14 화면 확인)
  const cur = kindOfLabel(c.prepaid_label) || kindOfLabel((c as any).prepaid_label_guess) || null;
  if (!cur || cur !== from || total === 0) return null;
  return { from, to: toKind, fromBalance: total };
}

/** 종류 기록 없는 옛 선결제 카드의 종류 짐작 — 처음 선결제로 빠진 주문(취소 빼고)의 종류. 표시·단계 변경 판단에만 쓴다(잔액은 안 건드림) */
export async function guessKinds(sb: SupabaseClient, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from('baby_food_orders').select('customer_id, delivery_date, created_at, stage, volume, items, total_qty, order_type, paid_note')
      .in('customer_id', ids.slice(i, i + 100)).neq('status', '취소').or('order_type.eq.선결제,paid_note.like.선결제 차감*')
      .order('delivery_date').order('created_at').limit(1000);
    for (const r of data || []) {
      if (out[r.customer_id] || String(r.stage || '').startsWith('반찬')) continue;
      const k = orderKinds(r)[0]?.kind;
      if (k) out[r.customer_id] = k;
    }
  }
  return out;
}

/** 표시용 '남은' — 섞인 주문을 여러 묶음에서 뺐으면 '중후300 2·중후230 5', 아니면 숫자 */
export const leftText = (r: { partAfter: number; moved?: Part[] }) =>
  r.moved && r.moved.length > 1 ? r.moved.map(p => `${shortKind(p.kind)} ${p.balance}`).join('·') : String(r.partAfter);

/** 장부 메모 앞에 붙일 묶음 이름 — 여러 묶음일 때만 */
export const kindTag = (r: { kind: string | null }) => r.kind ? `[${r.kind}] ` : '';
