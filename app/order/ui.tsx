'use client';
import { matchSeriousAllergens } from '@/lib/allergens';
import type { MenuReaction } from '@/lib/personalize';

/*
  주문 화면의 작은 조각들 — 틀, 로고, 버튼, 입력 모양.

  왜 따로 뒀나
    app/order/page.tsx 가 3,650줄이라 고치다 엉뚱한 데를 건드리기 쉬웠다.
    여기 있는 것은 받은 값만 그려내고 상태를 갖지 않아서, 떼어내도 동작이 그대로다.
*/

export function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="max-w-md mx-auto px-4 py-6 pb-36 safe-top">{children}</div>;
}

/**
 * 가게 로고. 브랜드 자리(화면 맨 위, 주문 완료)에 쓴다.
 * 전에는 🍱 이모지였는데, 어느 가게나 쓰는 그림이라 우리 것으로 바꿨다.
 * 원본 logo.png(774x891·395KB)는 아무도 안 써서 2026-11-13 지웠다(git 기록에 남음). 250x288·60KB 로
 * 줄인 logo-sm.png 를 쓴다(화면에서 제일 크게 쓰는 곳이 80px이라 2배까지 감당한다).
 */
export function Logo({ size = 52, className = '' }: { size?: number; className?: string }) {
  return (
    <img src="/logo-sm.png" alt="까꿍디미방" width={size} height={size}
      style={{ width: size, height: 'auto' }}
      className={`mx-auto object-contain ${className}`} />
  );
}

// 홈 화면에서 앱을 설치(PWA)해서 쓰면 브라우저 주소창이 없어서 /admin으로 갈 방법이 없었음 —
// 손님에게는 눈에 안 띄되 사장님은 언제든 누를 수 있는 위치(맨 아래)에 조용히 둔다.
export function AdminLink() {
  return (
    <div className="mt-10 pt-4 border-t border-stone-100 text-center">
      <a href="/admin" className="text-[11px] text-stone-300 hover:text-stone-500 active:text-stone-500 py-2 px-3 inline-block">
        관리자 로그인
      </a>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h2 className="text-[19px] font-extrabold text-stone-900 mb-4 tracking-[-0.02em]">{title}</h2>{children}</section>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block mb-3.5"><span className="text-xs text-stone-500 font-semibold mb-1.5 block tracking-[-0.01em]">{label}</span>{children}</label>;
}

export function SRow({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-3 py-1 border-b border-stone-50 last:border-0"><span className="text-stone-400">{k}</span><span className="text-stone-900 font-medium text-right">{v}</span></div>;
}

export function StepBar({ current, total }: { current: number; total: number }) {
  return <div className="flex gap-1 mt-2">{Array.from({ length: total }).map((_, i) =>
    <div key={i} className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${i + 1 <= current ? 'bg-amber-500' : 'bg-amber-100'}`} />)}</div>;
}

export function PrimaryBtn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return <button onClick={onClick} disabled={disabled} className="flex-1 py-3.5 bg-amber-500 text-white font-bold rounded-xl shadow-sm shadow-amber-500/25 active:bg-amber-600 disabled:bg-stone-200 disabled:text-stone-400 disabled:shadow-none">{children}</button>;
}

export function BackBtn({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="px-5 py-3.5 bg-white border border-amber-100 text-stone-600 font-semibold rounded-xl active:bg-amber-50">이전</button>;
}

export function Row2({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2 mt-5">{children}</div>;
}

export function QtyCtrl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  // 터치 타깃을 44px 가깝게 키움(모바일 접근성 권장치) + 선택된 수량은 색으로 구분
  return <div className="flex items-center gap-1.5">
    <button aria-label="수량 줄이기" onClick={() => onChange(value - 1)} disabled={value <= 0}
      className="w-10 h-10 rounded-xl bg-amber-100 text-amber-800 font-black text-xl leading-none disabled:opacity-25 flex items-center justify-center active:bg-amber-200">−</button>
    <span className={`w-8 text-center font-extrabold text-[17px] tabular-nums ${value > 0 ? 'text-amber-700' : 'text-stone-300'}`}>{value}</span>
    <button aria-label="수량 늘리기" onClick={() => onChange(value + 1)} disabled={value >= 10}
      className="w-10 h-10 rounded-xl bg-amber-100 text-amber-800 font-black text-xl leading-none disabled:opacity-25 flex items-center justify-center active:bg-amber-200">+</button>
  </div>;
}

export function StatBtn({ on, onClick, cls, children }: { on: boolean; onClick: () => void; cls: string; children: React.ReactNode }) {
  const active: Record<string, string> = {
    amber: 'bg-amber-500 border-amber-500', emerald: 'bg-emerald-500 border-emerald-500', rose: 'bg-rose-500 border-rose-500',
  };
  return (
    <button onClick={onClick}
      className={`w-7 h-7 rounded-lg border text-xs flex items-center justify-center transition ${on ? active[cls] + ' scale-110' : 'bg-white border-stone-200 opacity-50 hover:opacity-100'}`}>
      {children}
    </button>
  );
}

// 메뉴 반응 기록 컨트롤 (먹은 뒤 아기 반응)
export function ReactionCtrl({ name, current, onRate }: { name: string; current?: MenuReaction; onRate: (n: string, r: MenuReaction) => void }) {
  const opts: { r: MenuReaction; emoji: string; label: string }[] = [
    { r: 'like', emoji: '👍', label: '잘먹음' },
    { r: 'meh', emoji: '😐', label: '보통' },
    { r: 'dislike', emoji: '👎', label: '안먹음' },
  ];
  return (
    <div className="mt-1 flex items-center gap-1">
      <span className="text-[10px] text-stone-400">먹은 반응:</span>
      {opts.map(o => (
        <button key={o.r} onClick={(e) => { e.stopPropagation(); onRate(name, o.r); }}
          className={`text-[11px] px-1.5 py-0.5 rounded border transition ${
            current === o.r ? 'bg-amber-100 border-amber-300 font-bold' : 'bg-white border-stone-200 opacity-60 hover:opacity-100'}`}>
          {o.emoji}
        </button>
      ))}
    </div>
  );
}

// 메뉴 재료에 걸린 알레르겐 경고 배지
export function AllergyBadge({ ingredients, allergies }: { ingredients: string; allergies: string[] }) {
  const hits = matchSeriousAllergens(ingredients, allergies);
  if (hits.length === 0) return null;
  return (
    <div className="mt-1 flex items-center gap-1 flex-wrap">
      <span className="text-[10px] font-bold text-rose-600 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded">
        ⚠️ 알레르기 주의
      </span>
      {hits.map(h => (
        <span key={h.key} className="text-[10px] font-bold text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded">
          {h.emoji} {h.label}
        </span>
      ))}
    </div>
  );
}

export const iCls = 'w-full px-3.5 py-3 bg-white border border-amber-100 rounded-xl outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100 transition text-[16px]';
export const iSmCls = 'w-full px-3 py-2.5 bg-white border border-amber-100 rounded-xl outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100 transition text-[16px]';
