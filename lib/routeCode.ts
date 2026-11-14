import table from './routeCodes.json';

// ────────────────────────────────────────────────────────────────
// 배송 순번(구역 코드) — 사장님이 엑셀 "전체주소록"에 직접 매겨둔 번호.
// 화곡2동 10 → 화곡1동 11 → … → 목동 28~31 처럼 실제로 도는 순서라,
// 이 번호대로 정렬하면 주소록이 곧 배송 동선이 된다.
//
// 매칭은 "주소"로만 한다.
// ⚠️ 이름 매칭은 넣었다가 뺐음 — 아기 이름이 흔해서 다른 손님과 충돌함.
//   실제로 강남 논현로의 '수아'가 화곡2동(10번), 분당의 '이안'이 32번으로 잘못 잡혔다.
//   배송지가 엉뚱하게 정렬되면 그날 동선이 통째로 꼬이므로, 확실하지 않으면
//   차라리 "구역 미지정"으로 남겨 사장님이 직접 판단하게 하는 편이 안전하다.
//
// 참고: 대단지 아파트는 동마다 순번이 갈리기도 해서(래미안목동아델리체 28~28.9),
// 같은 키에 번호가 여러 개면 가장 많이 쓰인 번호를 채택했다. 세부 조정은 사장님이 하면 됨.
// ────────────────────────────────────────────────────────────────
const byAddr = (table as any).byAddr as Record<string, number>;

// 손님이 "강서구화곡동"처럼 구와 동을 붙여 쓰는 경우가 있어, 앞의 시/군/구를 떼어
// 엑셀에 적힌 "화곡동" 형태로 맞춰준다.
function normDong(d: string): string {
  return d.replace(/^.*?[시군구](?=.)/, '');
}

export function addrKey(address: string): string {
  const a = String(address || '').replace(/\s+/g, ' ').trim();
  let m = a.match(/([가-힣]+[0-9]*동)\s*([0-9]+(?:-[0-9]+)?)/);
  if (m) return normDong(m[1]) + ' ' + m[2];
  m = a.match(/([가-힣]+(?:[0-9]+)?(?:가)?(?:대로|로)(?:[0-9]+[가-힣]?길)?)\s*,?\s*([0-9]+(?:-[0-9]+)?)/);
  if (m) return m[1] + ' ' + m[2];
  m = a.match(/([가-힣]+[0-9]*동)(?![로길])/);
  if (m) return normDong(m[1]);
  return '';
}

/*
  ── 직배송 동네 판정 ────────────────────────────────────────────
  팩당 500원이 걸린다. 강서·양천은 사장님이 직접 돌아서 기본가, 나머지는 당일배송·택배로
  나가서 팩당 500원이 붙는다.

  ⚠️ 전에는 주소 글자에 "강서구|양천구" 가 있는지만 봤다. 그런데 손님이 보내는 주소에는
     구가 빠지는 일이 흔하다 — "서울 등촌로 195", "화곡동22". 그러면 같은 강서구인데도
     당일배송으로 잡혀서 팩당 500원이 더 붙고, 직배송 주소록에서도 빠졌다(실제로 그랬다).

  그래서 위 배송 순번표(사장님이 직접 매긴 2,400여 주소, 전부 강서·양천)를 같이 본다.
  그 표에 있는 도로명·동이면 직접 도는 동네다. 다른 구·다른 시가 적혀 있으면 아니다
  — "중앙로" 처럼 어디에나 있는 도로명 때문에 엉뚱한 곳이 기본가로 잡히면 안 되기 때문이다.
*/
const roadRoot = (s: string) => s.match(/^([가-힣]+(?:[0-9]+)?(?:가)?(?:대로|로))/)?.[1] || '';
const dongRoot = (s: string) => s.match(/^([가-힣]+[0-9]*동)/)?.[1] || '';

/** 주소록 키에서 도로명·동 뿌리만 모은다 ("등촌로51가길 35" → "등촌로", "화곡1동" → 화곡1동·화곡동) */
const DIRECT_ROOTS: Set<string> = (() => {
  const out = new Set<string>();
  for (const k of Object.keys(byAddr)) {
    const head = k.split(' ')[0];
    const road = roadRoot(head);
    if (road) { out.add(road); continue; }
    const dong = dongRoot(head);
    if (dong) { out.add(dong); out.add(dong.replace(/[0-9]+(?=동$)/, '')); }
  }
  return out;
})();

/** 다른 구·다른 시가 적혀 있나 (강서·양천, 서울은 제외) */
function elsewhere(addr: string): boolean {
  const gus = addr.match(/[가-힣]{1,3}구(?![가-힣])/g) || [];
  if (gus.length && !gus.some(g => g === '강서구' || g === '양천구')) return true;
  const sis = (addr.match(/[가-힣]{2,4}시(?![가-힣])/g) || [])
    .filter(s => !/^서울(특별)?시$/.test(s));
  return sis.length > 0;
}

/** 사장님이 직접 도는 동네인가 (기본가) — 아니면 당일배송·택배(팩당 +500원) */
export function looksDirectDelivery(address: string): boolean {
  const a = String(address || '').replace(/\s+/g, ' ').trim();
  if (!a) return false;
  if (/강서구|양천구/.test(a)) return true;
  if (elsewhere(a)) return false;
  if (routeCodeOf(a) !== null) return true;
  const road = a.match(/([가-힣]+(?:[0-9]+)?(?:가)?(?:대로|로))(?![가-힣])/)?.[1];
  if (road && DIRECT_ROOTS.has(road)) return true;
  const dong = a.match(/([가-힣]+[0-9]*동)(?![로길])/)?.[1];
  if (dong) {
    const d = normDong(dong);
    if (DIRECT_ROOTS.has(d) || DIRECT_ROOTS.has(d.replace(/[0-9]+(?=동$)/, ''))) return true;
  }
  return false;
}

/*
  ── 미지정 주소를 비슷한 동네 근처로 (2026-11-14 사장님: "미지정일 경우는 비슷한 동네 근처로 배치")
  순번표에 없는 새 주소도, 같은 길(또는 같은 동)의 가장 가까운 번지 순번을 빌려 그 자리에 끼운다.
  같은 길이 표에 없으면 같은 동으로, 그것도 없으면 null(맨 뒤). 순번 자체는 저장하지 않는다 — 줄 세우기용이다.
*/
type NearRow = { full: string; num: number; code: number };
const NEAR: Map<string, NearRow[]> = (() => {
  const m = new Map<string, NearRow[]>();
  const add = (root: string, r: NearRow) => { if (!root) return; if (!m.has(root)) m.set(root, []); m.get(root)!.push(r); };
  for (const [k, code] of Object.entries(byAddr)) {
    const [head, numStr] = k.split(' ');
    const r = { full: head, num: parseInt(numStr || '', 10), code };
    const road = roadRoot(head);
    if (road) { add(road, r); continue; }
    const dong = dongRoot(head);
    if (dong) { add(dong, r); add(dong.replace(/[0-9]+(?=동$)/, ''), r); }
  }
  return m;
})();

function pickNear(list: NearRow[] | undefined, full: string, num: number): number | null {
  if (!list || !list.length) return null;
  const same = list.filter(r => r.full === full);
  const pool = same.length ? same : list;
  if (!Number.isFinite(num)) {
    const codes = pool.map(r => r.code).sort((a, b) => a - b);
    return codes[Math.floor(codes.length / 2)];   // 번지를 모르면 그 길·동의 가운데 순번
  }
  let best = pool[0];
  for (const r of pool) {
    const d = Number.isFinite(r.num) ? Math.abs(r.num - num) : Infinity;
    const bd = Number.isFinite(best.num) ? Math.abs(best.num - num) : Infinity;
    if (d < bd) best = r;
  }
  return best.code;
}

/** 순번이 없으면 같은 길·같은 동의 가까운 번지 순번으로 짐작 (줄 세우기용). 짐작도 못 하면 null */
export function nearRouteCodeOf(address: string): { code: number | null; guessed: boolean } {
  const a = String(address || '').replace(/\s+/g, ' ').trim();
  const exact = routeCodeOf(a);
  if (exact !== null) return { code: exact, guessed: false };
  const rm = a.match(/([가-힣]+(?:[0-9]+)?(?:가)?(?:대로|로)(?:[0-9]+[가-힣]?길)?)\s*,?\s*([0-9]+)?/);
  if (rm) {
    const c = pickNear(NEAR.get(roadRoot(rm[1])), rm[1], parseInt(rm[2] || '', 10));
    if (c !== null) return { code: c, guessed: true };
  }
  const dm = a.match(/([가-힣]+[0-9]*동)(?![로길])\s*([0-9]+)?/);
  if (dm) {
    const d = normDong(dm[1]);
    const c = pickNear(NEAR.get(d) || NEAR.get(d.replace(/[0-9]+(?=동$)/, '')), d, parseInt(dm[2] || '', 10));
    if (c !== null) return { code: c, guessed: true };
  }
  return { code: null, guessed: false };
}

/** 주소로 배송 순번을 찾음. 확실하지 않으면 null (억지로 맞추지 않음) */
export function routeCodeOf(address: string): number | null {
  const addr = String(address || '');
  const k = addrKey(addr);
  if (k && byAddr[k] !== undefined) return byAddr[k];
  // 번지까지는 못 맞춰도 같은 동이면 그 동의 순번으로 (예: "화곡2동 999-9" → "화곡2동")
  // 단 "목동로"의 '목동'처럼 도로명 일부를 동으로 오인하지 않도록 뒤에 로/길이 오면 제외
  const dong = addr.match(/([가-힣]+[0-9]*동)(?![로길])/)?.[1];
  if (dong) {
    const nd = normDong(dong);
    if (byAddr[nd] !== undefined) return byAddr[nd];
  }
  return null;
}
