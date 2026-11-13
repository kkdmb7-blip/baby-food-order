/*
  입금 ↔ 주문 짝짓기 (화면·서버 공용, DB 는 안 만진다 — 결과만 돌려준다)

  사장님 말씀 (2026-11-13)
    "보통은 아가이름+조리일로 부탁하지만 그렇게 안 하는 사람도 많아.
     엄마이름 아빠이름도 같이 저장해두고 맞춰봐야 해. 동명이인 가능성도 열어둬.
     금액이 안 맞거나 누군지 모르겠는 건 정리해서 보여주고, 체크된 것도 내가 확인할 수 있게."

  어떻게 맞추나
    1) 보낸 분 칸에서 날짜(11/12 · 1112 · 11.12 · 11월12일)를 떼어 내고 남은 한글을 이름으로 본다.
       카드사 정산(신한1014…) · 배민스토어 같은 건 손님 입금이 아니라 '무관'.
    2) 그 이름의 주문을 찾는다 — 아기 이름(뒤 숫자 뗀 것, 김도진3 → 김도진) 또는
       손님 카드에 저장된 입금자 이름(엄마·아빠 이름).
    3) 입금일 앞뒤 3주 안의, 아직 입금확인 안 된 주문들 중에서 금액이 딱 맞는 조합(1~3건)을 찾는다.
       날짜가 적혀 있으면 그 날짜 주문이 들어간 조합만 본다.
    4) 맞는 조합이 딱 하나 → '자동확인'. 여러 개 → '확인필요'(동명이인·중복 가능).
       이름은 맞는데 금액이 안 맞으면 → '확인필요'에 그 날 주문을 '아마 이것' 으로 붙여 둔다.
       선결제 할인표 금액과 같으면 → '선결제'.  이름을 못 찾으면 → '모름'.
    5) 같은 사람이 같은 날 나눠 보낸 입금(2,000 + 19,000)은 합쳐서 한 번 더 본다.
  자동확인도 근거(note)를 남기고, 사장님이 풀 수 있다.
*/

export type MOrder = {
  id: string; baby_name: string; delivery_date: string; customer_phone: string;
  total_price: number; shipping_fee: number; total_qty: number; stage: string | null;
  delivery_method: string | null; paid: boolean; paid_note: string | null;
};
export type MDeposit = { id: string; deposited_at: string; depositor: string; amount: number };
export type MResult = {
  id: string;
  status: '자동확인' | '확인필요' | '모름' | '선결제' | '무관';
  order_ids: string[]; suggested_ids: string[]; customer_phone: string | null; note: string;
};

// 차감식 선결제 할인표 (2024.11.1 간판, 현금만)
export const PREPAID_PRICES: Record<number, string> = {
  96000: '20팩 230g', 142500: '30팩 230g', 235000: '50팩 230g',
  116000: '20팩 300g', 172500: '30팩 300g', 285000: '50팩 300g',
  106000: '완료기 20팩 230g', 157500: '완료기 30팩 230g', 260000: '완료기 50팩 230g',
  126000: '완료기 20팩 300g', 187500: '완료기 30팩 300g', 310000: '완료기 50팩 300g',
};

const kstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
const won = (n: number) => n.toLocaleString('ko-KR') + '원';
export const nameKey = (n: string) => String(n || '').replace(/\s/g, '').replace(/\d+$/, '');

export function parseDepositor(raw: string, depositedAt: string): { name: string; hint: string | null; nonCustomer: boolean } {
  let s = String(raw || '').replace(/[\s　]+/g, '');
  if (/^(신한|하나|삼성|국민|KB|우리|농협|NH|현대|롯데|비씨|BC|씨티|카카오|토스|케이|IBK|기업)\d{5,}$/i.test(s)
      || /배민|쿠팡|스마트스토어|네이버페이|정산/.test(s)) {
    return { name: s, hint: null, nonCustomer: true };
  }
  const year = Number(depositedAt.slice(0, 4));
  let hint: string | null = null;
  const take = (m: RegExpMatchArray | null, mo: number, dd: number) => {
    if (!m || mo < 1 || mo > 12 || dd < 1 || dd > 31) return false;
    const depMonth = Number(kstDate(depositedAt).slice(5, 7));
    const y = depMonth === 12 && mo === 1 ? year + 1 : depMonth === 1 && mo === 12 ? year - 1 : year;
    hint = `${y}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    s = s.replace(m[0], '');
    return true;
  };
  let m = s.match(/(\d{1,2})월(\d{1,2})일?/);
  if (!take(m, Number(m?.[1]), Number(m?.[2]))) {
    m = s.match(/(\d{1,2})[\/.](\d{1,2})\.?일?/);
    if (!take(m, Number(m?.[1]), Number(m?.[2]))) {
      m = s.match(/(?<!\d)(1[0-2]|0[1-9])([0-3]\d)(?!\d)/);
      take(m, Number(m?.[1]), Number(m?.[2]));
    }
  }
  let name = s.replace(/[^가-힣]/g, '')
    .replace(/^일(?=[가-힣]{2,})/, '')
    .replace(/(아기|아가|반찬|이유식|조리|입금)+$/, '');
  return { name, hint, nonCustomer: false };
}

/** 주문 하나가 받아야 할 돈 (상품값 + 배송비) */
const due = (o: MOrder) => (o.total_price || 0) + (o.shipping_fee || 0);

export function matchDeposits(
  deposits: MDeposit[], orders: MOrder[], payerNames: Record<string, string[]> /* phone → 입금자 이름들 */,
): MResult[] {
  const results: MResult[] = [];
  const claimed = new Set<string>();
  const byId: Record<string, MOrder> = Object.fromEntries(orders.map(o => [o.id, o]));
  const open = (o: MOrder) => !o.paid && !claimed.has(o.id);
  const sorted = [...deposits].sort((a, b) => a.deposited_at.localeCompare(b.deposited_at));

  // 입금자 이름 → 그 이름을 쓰는 손님 번호들
  const payerPhones: Record<string, Set<string>> = {};
  for (const [phone, names] of Object.entries(payerNames)) for (const n of names || []) (payerPhones[nameKey(n)] ||= new Set()).add(phone);

  function candidatesFor(name: string) {
    const k = nameKey(name);
    if (k.length < 2) return [];
    const phones = payerPhones[k];
    return orders.filter(o => nameKey(o.baby_name) === k || o.baby_name === name || (phones && phones.has(o.customer_phone)));
  }

  /*
    금액이 맞는 주문 조합 찾기 (1~3건)
      날짜가 적힌 입금: 그 날짜 주문이 꼭 들어가야 한다. 그 날짜 주문이 없으면 자동으로 맞추지 않는다
                       (다른 날 같은 금액으로 맞추면 틀리기 쉽다 — 실제로 10/26 주문에 붙은 적 있음).
      날짜 없는 입금: 입금일 앞뒤 7일.
  */
  function solve(amount: number, depDate: string, hint: string | null, cands: MOrder[]) {
    const pool = cands
      .filter(o => open(o) && Math.abs(dayDiff(o.delivery_date, hint || depDate)) <= 7)
      .sort((a, b) => Math.abs(dayDiff(a.delivery_date, hint || depDate)) - Math.abs(dayDiff(b.delivery_date, hint || depDate)))
      .slice(0, 9);
    const hintHas = hint ? pool.some(o => o.delivery_date === hint) : false;
    const found: { ids: string[] }[] = [];
    if (hint && !hintHas) return { pool, found, hintHas };
    const n = pool.length;
    for (let size = 1; size <= 3 && found.length === 0; size++) {
      const idx: number[] = [];
      const rec = (start: number) => {
        if (idx.length === size) {
          const pick = idx.map(i => pool[i]);
          if (hintHas && !pick.some(o => o.delivery_date === hint)) return;
          if (pick.reduce((s, o) => s + due(o), 0) === amount) found.push({ ids: pick.map(o => o.id) });
          return;
        }
        for (let i = start; i < n; i++) { idx.push(i); rec(i + 1); idx.pop(); }
      };
      rec(0);
    }
    // 날짜 없이 같은 금액 주문이 여러 날 있으면 — 입금 뒤 7일 안에 오는 주문 하나뿐이면 그걸로 본다
    if (!hint && found.length > 1) {
      const ahead = found.filter(f => f.ids.every(id => { const d = dayDiff(byId[id].delivery_date, depDate); return d >= 0 && d <= 7; }));
      if (ahead.length === 1) return { pool, found: ahead, hintHas, picked: '날짜가 안 적혀 있어 입금 뒤 가장 가까운 주문으로 봄' };
    }
    return { pool, found, hintHas };
  }

  const describe = (ids: string[]) => ids.map(id => byId[id]).map(o => `${o.baby_name} ${o.delivery_date.slice(5).replace('-', '/')} ${won(due(o))}`).join(' + ');

  for (const d of sorted) {
    const depDate = kstDate(d.deposited_at);
    const p = parseDepositor(d.depositor, d.deposited_at);
    const base = { id: d.id, order_ids: [] as string[], suggested_ids: [] as string[], customer_phone: null as string | null };
    if (p.nonCustomer) { results.push({ ...base, status: '무관', note: '카드·플랫폼 정산으로 보임 — 손님 입금 아님' }); continue; }
    const cands = candidatesFor(p.name);
    const phones = [...new Set(cands.map(o => o.customer_phone).filter(Boolean))];
    const sameName = phones.length > 1 ? ` · '${p.name}' 손님이 ${phones.length}명(동명이인 가능)` : '';
    const prepaid = PREPAID_PRICES[d.amount];

    if (cands.length === 0) {
      results.push({
        ...base, status: prepaid ? '선결제' : '모름',
        note: (prepaid ? `선결제 할인표 금액(${prepaid}) — ` : '') + `'${p.name || d.depositor}' 이름의 주문이 없어요 (엄마·아빠 이름일 수 있어요)` + (p.hint ? ` · 적힌 날짜 ${p.hint.slice(5)}` : ''),
      });
      continue;
    }
    const sol = solve(d.amount, depDate, p.hint, cands);
    const { pool, found } = sol;
    if (found.length === 1) {
      const ids = found[0].ids;
      const ph = [...new Set(ids.map(id => byId[id].customer_phone))];
      ids.forEach(id => claimed.add(id));
      results.push({
        ...base, status: '자동확인', order_ids: ids, customer_phone: ph.length === 1 ? ph[0] || null : null,
        note: `${describe(ids)} = ${won(d.amount)}` + ((sol as any).picked ? ` · ${(sol as any).picked}` : '') + sameName,
      });
      continue;
    }
    if (found.length > 1) {
      const ids = [...new Set(found.flatMap(f => f.ids))];
      results.push({ ...base, status: '확인필요', suggested_ids: ids, note: `금액이 맞는 조합이 ${found.length}가지 — 어느 주문인지 골라주세요` + sameName });
      continue;
    }
    if (prepaid) {
      results.push({ ...base, status: '선결제', customer_phone: phones.length === 1 ? phones[0] : null, note: `선결제 할인표 금액(${prepaid})` + sameName });
      continue;
    }
    const hintOrders = p.hint ? cands.filter(o => o.delivery_date === p.hint) : [];
    const paidAlready = hintOrders.filter(o => o.paid || claimed.has(o.id));
    const near = p.hint
      ? pool.filter(o => o.delivery_date === p.hint)
      : pool.filter(o => Math.abs(dayDiff(o.delivery_date, depDate)) <= 3).slice(0, 3);
    // 적힌 날짜에 주문이 없으면, 금액이 같은 다른 날 주문을 '아마 이것' 으로만 붙여 둔다
    const sameAmountElsewhere = p.hint && hintOrders.length === 0
      ? cands.filter(o => open(o) && due(o) === d.amount && Math.abs(dayDiff(o.delivery_date, p.hint!)) <= 14).slice(0, 3)
      : [];
    let note: string;
    if (near.length) note = `금액이 안 맞아요 — 주문 ${describe(near.map(o => o.id))} / 입금 ${won(d.amount)}`;
    else if (p.hint && hintOrders.length === 0) note = `${p.hint.slice(5)} 주문이 엑셀·앱에 없어요 (수량을 안 적었거나, 미리 보낸 돈일 수 있어요)` + (sameAmountElsewhere.length ? ` · 금액이 같은 다른 날 주문: ${describe(sameAmountElsewhere.map(o => o.id))}` : '');
    else if (paidAlready.length) note = `${p.hint!.slice(5)} 주문은 이미 다른 입금으로 확인됐어요 — 두 번 보냈는지 확인해 주세요`;
    else note = `가까운 날 입금 안 된 주문이 없어요`;
    results.push({
      ...base, status: '확인필요', suggested_ids: [...near, ...sameAmountElsewhere].map(o => o.id),
      customer_phone: phones.length === 1 ? phones[0] : null, note: note + sameName,
    });
  }

  // 같은 사람이 같은 날 나눠 보낸 것 — 합쳐서 다시
  const groups: Record<string, MResult[]> = {};
  for (const r of results) {
    if (r.status !== '확인필요' && r.status !== '모름') continue;
    const d = deposits.find(x => x.id === r.id)!;
    const p = parseDepositor(d.depositor, d.deposited_at);
    (groups[`${p.name}|${kstDate(d.deposited_at)}`] ||= []).push(r);
  }
  for (const [key, rs] of Object.entries(groups)) {
    if (rs.length < 2) continue;
    const ds = rs.map(r => deposits.find(x => x.id === r.id)!);
    const total = ds.reduce((s, d) => s + d.amount, 0);
    const [name, day] = key.split('|');
    const hint = ds.map(d => parseDepositor(d.depositor, d.deposited_at).hint).find(Boolean) || null;
    const { found } = solve(total, day, hint, candidatesFor(name));
    if (found.length === 1) {
      found[0].ids.forEach(id => claimed.add(id));
      for (const r of rs) {
        r.status = '자동확인'; r.order_ids = found[0].ids; r.suggested_ids = [];
        r.note = `같은 날 나눠 보낸 ${rs.length}건 합계 ${won(total)} = ${describe(found[0].ids)}`;
      }
    }
  }
  return results;
}
