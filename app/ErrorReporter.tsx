'use client';
import { useEffect } from 'react';

// 손님 브라우저에서 난 오류를 자동으로 서버(/api/log-error)로 보내 텔레그램 알림이 가게 함.
// 예전엔 console.error가 손님 폰 안에서만 찍히고 아무 데도 안 가서, 오류가 나도
// 사장님이 알 방법이 전혀 없었음(반찬 주문 불가·조리표 500 모두 아무도 몰랐던 이유).
export default function ErrorReporter() {
  useEffect(() => {
    let sent = 0;
    const MAX_PER_SESSION = 5; // 오류 루프가 나도 서버·텔레그램을 도배하지 않도록

    function report(message: string, stack?: string) {
      if (!message || sent >= MAX_PER_SESSION) return;
      sent++;
      try {
        const payload = JSON.stringify({
          message, stack,
          where: location.pathname + location.search,
        });
        // 페이지가 닫히는 중에도 전송되도록 sendBeacon 우선
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/log-error', new Blob([payload], { type: 'application/json' }));
        } else {
          fetch('/api/log-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
        }
      } catch {}
    }

    function onError(e: ErrorEvent) {
      report(e.message || '알 수 없는 오류', e.error?.stack);
    }
    function onRejection(e: PromiseRejectionEvent) {
      const r: any = e.reason;
      report(r?.message ? `처리되지 않은 오류: ${r.message}` : `처리되지 않은 오류: ${String(r).slice(0, 200)}`, r?.stack);
    }

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
