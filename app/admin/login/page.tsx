'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '로그인 실패');
      router.push('/admin');
    } catch (e: any) {
      setErr(e.message || '오류');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto px-5 py-20">
      <div className="bg-white rounded-2xl p-8 shadow-sm border border-brand-100">
        <div className="text-[11px] tracking-[0.3em] text-brand-600 font-bold mb-1">ADMIN</div>
        <h1 className="text-xl font-bold text-stone-900 mb-6">관리자 로그인</h1>
        <form onSubmit={submit}>
          <input
            type="password"
            value={pw}
            onChange={e => setPw(e.target.value)}
            placeholder="비밀번호"
            autoFocus
            className="w-full px-3.5 py-3 bg-white border border-brand-100 rounded-xl outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 mb-3"
          />
          {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{err}</div>}
          <button
            disabled={loading || !pw}
            className="w-full py-3.5 bg-brand-500 text-white font-bold rounded-xl active:bg-brand-600 disabled:bg-stone-200 disabled:text-stone-400"
          >
            {loading ? '확인 중…' : '로그인'}
          </button>
        </form>
      </div>
    </div>
  );
}
