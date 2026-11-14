'use client';
import { useEffect, useState } from 'react';
import { PREPAID_UNITS, prepaidPrice } from '@/lib/supabase';

/*
  선결제 충전 단추 — 종류를 먼저 고르고 20·30·50팩을 누른다.
  2026-11-14 사장님: "추가 버튼 3개가 전부 한 가지만 된다. 중기·후기 230 말고 300도 있고 완료기 230·300도 있다"
  간판 할인표는 네 가지(중기·후기 230 / 300, 완료기 230 / 300)라 고르는 칸도 넷이다.
  손님에게 이미 '후기 300g' 처럼 단계가 적혀 있고 같은 값의 종류를 고르면 그 이름을 그대로 남긴다.
*/
export const CHARGE_KINDS = ['중기·후기 230g', '중기·후기 300g', '완료기 230g', '완료기 300g'] as const;

function kindOf(label?: string | null): typeof CHARGE_KINDS[number] {
  const s = String(label || '');
  const big = /3[01]0/.test(s);
  if (/완료/.test(s)) return big ? '완료기 300g' : '완료기 230g';
  return big ? '중기·후기 300g' : '중기·후기 230g';
}

export default function ChargeBar({ label, disabled, onCharge, size = 'md' }: {
  label?: string | null;                 // 손님의 지금 단계 (없으면 주문에서 짐작한 값)
  disabled?: boolean;
  onCharge: (units: number, label: string, won: number) => void;
  size?: 'sm' | 'md';
}) {
  const [kind, setKind] = useState<typeof CHARGE_KINDS[number]>(kindOf(label));
  useEffect(() => { setKind(kindOf(label)); }, [label]);
  // 같은 값 묶음이면 손님에게 적힌 이름('후기 300g')을 그대로 쓴다
  const sendLabel = label && kindOf(label) === kind ? label : kind;
  const cls = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]';
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <select value={kind} onChange={e => setKind(e.target.value as any)} disabled={disabled}
        className={`border border-amber-300 rounded bg-white text-amber-900 font-bold ${size === 'sm' ? 'text-[11px] py-0.5' : 'text-[12px] py-1'}`}>
        {CHARGE_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
      </select>
      {PREPAID_UNITS.map(u => {
        const won = prepaidPrice(kind, u)!;
        return (
          <button key={u} disabled={disabled} onClick={() => onCharge(u, sendLabel, won)}
            className={`${cls} border border-amber-200 bg-white text-amber-800 rounded-lg font-bold hover:bg-amber-50 disabled:opacity-40`}>
            +{u}팩 <span className="font-normal text-stone-500">{won.toLocaleString()}원</span>
          </button>
        );
      })}
    </div>
  );
}
