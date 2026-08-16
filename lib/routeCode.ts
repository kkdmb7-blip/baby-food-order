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
