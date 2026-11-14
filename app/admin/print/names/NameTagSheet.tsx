'use client';
import { useMemo, useState } from 'react';
import PrintBar from '../PrintBar';

export type Tag = { key: string; name: string; kind: string; pickup: boolean; parcel: boolean };

// 엑셀 '이유식이름' 시트 크기 (90% 배율 반영) — 칸 39mm × 19.4mm, 5칸 × 14줄
const COLS = 5;
const ROWS = 14;
const PER_PAGE = COLS * ROWS;

// columnFirst — 반찬 날: 엑셀 '이름' 시트처럼 칸을 위에서 아래로(한 줄 다 차면 옆 줄) 채운다. 1회→정기→오픈월드→메뉴변경 순서가 세로로 이어진다
export default function NameTagSheet({ date, tags, columnFirst = false }: { date: string; tags: Tag[]; columnFirst?: boolean }) {
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [extra, setExtra] = useState('');
  const [skip, setSkip] = useState(0);         // 이미 쓴 칸 — 앞에서부터 비운다
  const [copies, setCopies] = useState(1);      // 한 이름당 몇 장

  const extraNames = useMemo(() => extra.split(/[\n,，]+/).map(s => s.trim()).filter(Boolean).slice(0, 200), [extra]);
  const names = useMemo(() => {
    const list = [...tags.filter(t => !off[t.key]).map(t => t.name), ...extraNames];
    return list.flatMap(n => Array.from({ length: copies }, () => n));
  }, [tags, off, extraNames, copies]);
  const cells: (string | null)[] = [...Array.from({ length: skip }, () => null), ...names];
  const pages: (string | null)[][] = [];
  for (let i = 0; i < Math.max(cells.length, 1); i += PER_PAGE) {
    const pg = cells.slice(i, i + PER_PAGE);
    while (pg.length < PER_PAGE) pg.push(null);
    pages.push(pg);
  }
  const fontFor = (n: string) => (n.length <= 4 ? '23.4pt' : n.length <= 5 ? '19pt' : n.length <= 7 ? '14pt' : '11pt');

  return (
    <div className="bg-white min-h-screen text-black">
      {/* 따옴표가 든 CSS 를 자식 글자로 넣으면 서버·브라우저가 다르게 적어 화면 맞추기 오류가 난다 */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          @page { size: A4 portrait; margin: 0; }
          html, body { margin: 0; padding: 0; }
          .tag-page { page-break-after: always; break-after: page; }
          .tag-page:last-child { page-break-after: auto; break-after: auto; }
        }
        .tag-page { width: 210mm; height: 297mm; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
        .tag-grid { display: grid; grid-template-columns: repeat(${COLS}, 39mm); grid-template-rows: repeat(${ROWS}, 19.4mm); }
        .tag-cell { border: 1px dotted #444; margin: 0 -1px -1px 0; display: flex; align-items: center; justify-content: center;
          font-family: 'Malgun Gothic', '맑은 고딕', sans-serif; white-space: nowrap; overflow: hidden; }
      ` }} />

      <div className="no-print p-3 border-b border-stone-200 space-y-2 max-w-3xl">
        <div className="flex justify-between items-center flex-wrap gap-2">
          <div className="font-black">이름표 {date} · {names.length}장 · {pages.length}쪽</div>
          <PrintBar date={date} kind="names" />
        </div>
        <p className="text-xs text-stone-500 leading-relaxed">
          엑셀 이름표와 같은 크기예요(한 장 70칸, 점선이 자르는 선). 이름을 누르면 이번 인쇄에서 빠지고, 다시 누르면 들어가요.
          수량 없이 적어 둔 늦은 주문 이름도 같이 나옵니다.
        </p>
        <div className="flex flex-wrap gap-1">
          {tags.map(t => (
            <button key={t.key} onClick={() => setOff(o => ({ ...o, [t.key]: !o[t.key] }))}
              className={`text-xs px-2 py-1 rounded border ${off[t.key] ? 'border-stone-200 text-stone-300 line-through' : 'border-stone-300 text-stone-800'}`}>
              {t.name}
              {t.kind !== '이유식' && <span className="ml-1 text-[10px] text-lime-700">{t.kind}</span>}
              {t.pickup && <span className="ml-1 text-[10px] text-sky-700">픽업</span>}
              {t.parcel && <span className="ml-1 text-[10px] text-violet-700">택배</span>}
            </button>
          ))}
          {tags.length === 0 && <span className="text-xs text-stone-400">이날 주문이 없어요 — 아래에 이름을 적어 넣을 수 있어요</span>}
        </div>
        <textarea value={extra} onChange={e => setExtra(e.target.value)} rows={2}
          placeholder="더 넣을 이름 (줄을 바꾸거나 쉼표로 여러 명)"
          className="w-full px-2 py-1.5 border border-stone-300 rounded text-sm outline-none focus:border-amber-400" />
        <div className="flex flex-wrap items-center gap-3 text-xs text-stone-600">
          <label className="flex items-center gap-1">
            앞에서
            <input value={skip || ''} onChange={e => setSkip(Math.min(PER_PAGE - 1, Number(e.target.value.replace(/\D/g, '')) || 0))}
              inputMode="numeric" placeholder="0" className="w-12 px-1.5 py-0.5 border border-stone-300 rounded text-right" />
            칸 비우기 <span className="text-stone-400">(쓰다 남은 종이에 뽑을 때)</span>
          </label>
          <label className="flex items-center gap-1">
            한 이름당
            <select value={copies} onChange={e => setCopies(Number(e.target.value))} className="border border-stone-300 rounded px-1 py-0.5">
              {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}장</option>)}
            </select>
          </label>
        </div>
      </div>

      {pages.map((pg, pi) => (
        <div key={pi} className="tag-page">
          <div className="tag-grid" style={columnFirst ? { gridAutoFlow: 'column' } : undefined}>
            {pg.map((n, i) => (
              <div key={i} className="tag-cell" style={{ fontSize: n ? fontFor(n) : undefined }}>{n || ''}</div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
