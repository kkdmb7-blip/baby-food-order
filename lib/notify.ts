// ────────────────────────────────────────────────────────────────
// 운영 알림 — fortuna-worker의 /notify-error를 재사용해 텔레그램(@kkdmbbot)으로 전송.
// 그쪽에서 tg_alert_log 테이블에도 기록되므로 나중에 "무슨 오류가 났었는지" 조회로 확인 가능.
//
// 이 앱은 손님이 오류를 만나도 그냥 창을 닫고 떠나기 때문에 사장님이 알 방법이 없었음
// (반찬 주문이 한 건도 성공한 적 없던 것, 조리표가 500이던 것 모두 아무도 몰랐음).
// 그래서 실패는 조용히 넘기지 말고 여기로 모은다.
//
// 메시지 규칙: 이모지 쓰지 않고 [라벨] + "항목: 값" 라인만 사용 (기존 알림과 통일).
// ────────────────────────────────────────────────────────────────
const NOTIFY_URL = 'https://fortuna.kkdmb7.workers.dev/notify-error';

// 같은 오류가 반복될 때 텔레그램이 도배되지 않도록 10분 내 동일 메시지는 1회만
const recent = new Map<string, number>();
const DEDUPE_MS = 10 * 60_000;

export function kstStamp(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** 알림 전송 — 실패해도 호출부 흐름을 절대 막지 않는다(알림 때문에 주문이 실패하면 본말전도) */
export async function notify(label: string, lines: Record<string, string | number | null | undefined>, title: string): Promise<void> {
  try {
    const body = Object.entries(lines)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const message = `[${title}]\n\n${body}\n시각: ${kstStamp()} KST`;

    const key = `${label}:${message}`;
    const now = Date.now();
    const prev = recent.get(key);
    if (prev && now - prev < DEDUPE_MS) return;
    recent.set(key, now);
    if (recent.size > 200) {
      for (const [k, t] of recent) if (now - t > DEDUPE_MS) recent.delete(k);
    }

    const sharedKey = process.env.NOTIFY_SHARED_KEY;
    await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 서버간 호출은 브라우저 Origin이 없어서 화이트리스트를 통과 못 함 — 공유키로 인증
        ...(sharedKey ? { 'X-Notify-Key': sharedKey } : {}),
      },
      body: JSON.stringify({ where: `bfo-${label}`, message }),
    });
  } catch (e) {
    console.error('[notify]', e);
  }
}

/** 오류 알림 — 서버/클라이언트 어디서 났는지, 어떤 상황이었는지까지 담아 보낸다 */
export async function notifyError(
  label: string,
  err: unknown,
  context: Record<string, string | number | null | undefined> = {}
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : '';
  await notify(label, { ...context, 오류: msg.slice(0, 300), 위치: stack.slice(0, 300) }, '이유식앱 오류');
}
