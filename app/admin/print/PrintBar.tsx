'use client';

// ⚠️ 조리표·주소록 페이지는 서버 컴포넌트(async function)라서 onClick을 직접 달 수 없다.
// 예전엔 서버 컴포넌트 안에 <button onClick={() => window.print()}>가 있어서
// "Event handlers cannot be passed to Client Component props" 오류로 페이지가 통째로
// 500이 나면서 인쇄 자체가 불가능했음 — 버튼만 클라이언트 컴포넌트로 분리한다.
// 종이는 세 장이고 쓰는 사람이 다르다 — 조리실(조리표), 담는 대(담는 수량), 배송(주소록).
// 한 장에서 나머지 두 장으로 바로 갈 수 있어야 아침에 돌아다니지 않는다.
const SHEETS = [
  { kind: 'cooking', path: 'cooking', label: '🍲 조리표' },
  { kind: 'tally',   path: 'tally',   label: '📋 담는 수량' },
  { kind: 'labels',  path: 'labels',  label: '🚚 배송 주소록' },
  { kind: 'names',   path: 'names',   label: '이름표' },
] as const;

export default function PrintBar({ date, kind }: { date: string; kind: 'cooking' | 'labels' | 'tally' | 'names' }) {
  const others = SHEETS.filter(s => s.kind !== kind);
  return (
    <div className="no-print flex gap-2 flex-shrink-0">
      <button onClick={() => window.print()}
        className="px-5 py-2 bg-black text-white rounded-lg font-bold text-sm">🖨 인쇄</button>
      {others.map(o => (
        <a key={o.kind} href={`/admin/print/${o.path}?date=${date}`}
          className="px-4 py-2 bg-stone-100 border border-stone-300 rounded-lg text-sm font-bold flex items-center">{o.label}</a>
      ))}
      <a href="/admin" className="px-4 py-2 bg-stone-200 rounded-lg text-sm flex items-center">닫기</a>
    </div>
  );
}
