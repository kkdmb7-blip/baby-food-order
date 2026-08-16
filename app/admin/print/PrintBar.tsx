'use client';

// ⚠️ 조리표·주소록 페이지는 서버 컴포넌트(async function)라서 onClick을 직접 달 수 없다.
// 예전엔 서버 컴포넌트 안에 <button onClick={() => window.print()}>가 있어서
// "Event handlers cannot be passed to Client Component props" 오류로 페이지가 통째로
// 500이 나면서 인쇄 자체가 불가능했음 — 버튼만 클라이언트 컴포넌트로 분리한다.
export default function PrintBar({ date, kind }: { date: string; kind: 'cooking' | 'labels' }) {
  const other = kind === 'cooking'
    ? { href: `/admin/print/labels?date=${date}`, label: '🚚 배송 주소록' }
    : { href: `/admin/print/cooking?date=${date}`, label: '🍲 조리표' };
  return (
    <div className="no-print flex gap-2 flex-shrink-0">
      <button onClick={() => window.print()}
        className="px-5 py-2 bg-black text-white rounded-lg font-bold text-sm">🖨 인쇄</button>
      <a href={other.href}
        className="px-4 py-2 bg-stone-100 border border-stone-300 rounded-lg text-sm font-bold flex items-center">{other.label}</a>
      <a href="/admin" className="px-4 py-2 bg-stone-200 rounded-lg text-sm flex items-center">닫기</a>
    </div>
  );
}
