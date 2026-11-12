import { createHash, timingSafeEqual } from 'node:crypto';

/*
  서버끼리만 부르는 경로를 막는 토큰.

  왜 필요한가
    /api/notify 는 주문이 들어오면 사장님께 메일을 보내는 경로인데, 누구나 부를 수 있었다.
    호출하는 곳은 /api/orders 한 군데뿐(서버 → 서버)인데도 열려 있었다.
    바깥에서 부르면
      - 사장님 메일함에 가짜 '[새 주문]' 이 쌓인다
      - 아기 이름·주소·연락처를 전부 보내는 쪽이 정하므로, 있지도 않은 주문을
        진짜처럼 꾸며 보낼 수 있다. 사장님이 그걸 보고 조리·배송하면 손해다
      - 메일 발송 한도를 남이 태울 수 있다

  왜 환경변수를 새로 만들지 않았나
    새 변수를 만들면 Vercel 에 넣는 걸 잊었을 때 알림이 조용히 끊긴다.
    부르는 쪽과 받는 쪽이 같은 배포라 환경변수도 같다. 그래서 이미 있는 값에서
    토큰을 만든다 — 따로 설정할 게 없고, 값이 없으면 양쪽 다 건너뛴다.
    (/api/notify 는 RESEND_API_KEY 가 없으면 어차피 아무것도 안 하고 끝난다)
*/
export function internalToken(): string | null {
  const k = process.env.RESEND_API_KEY || '';
  if (!k) return null;
  return createHash('sha256').update('kkdmb-internal:' + k).digest('hex').slice(0, 32);
}

/**
 * 토큰 비교.
 * ⚠️ 처음엔 길이를 맞추려고 slice 로 잘라서 비교했는데, 맞는 토큰 뒤에 아무 글자나
 *    붙여도 통과했다(잘라내고 나면 같아지니까). 길이가 다르면 바로 막는다.
 *    길이는 32로 고정이라 길이를 노출해도 잃을 게 없다.
 */
export function tokenMatches(got: string | null | undefined, expect: string | null): boolean {
  if (!expect) return true;          // 토큰을 만들 수 없는 환경이면 검사하지 않는다
  const s = String(got || '');
  if (s.length !== expect.length) return false;
  try { return timingSafeEqual(Buffer.from(s), Buffer.from(expect)); } catch { return false; }
}

export const INTERNAL_HEADER = 'x-kkdmb-internal';
