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

/** 장부 메모 앞에 붙일 묶음 이름 — 여러 묶음일 때만 */
export const kindTag = (r: { kind: string | null }) => r.kind ? `[${r.kind}] ` : '';
