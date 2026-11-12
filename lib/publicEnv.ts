/*
  브라우저에서 쓰는 Supabase 주소와 공개 열쇠.

  왜 한 군데로 모았나
    전에는 다섯 군데(주문 화면 네 곳 · /api/menus/current)에 주소와 열쇠가 그대로
    박혀 있었다. 프로젝트를 옮기거나 열쇠를 바꾸면 다섯 군데를 손으로 고쳐야 하고,
    한 군데만 놓치면 그 화면만 조용히 안 되는 상태가 된다.

  열쇠가 코드에 있어도 되는 이유
    sb_publishable_ 로 시작하는 공개 열쇠다. 브라우저로 내려가는 값이라 숨길 수 없고
    숨길 필요도 없다. 실제 보호는 Supabase 쪽 RLS 가 한다.
    (service_role 열쇠는 절대 여기 두면 안 된다 — 서버 전용 lib/supabase.ts 에 있다)

  환경변수를 먼저 쓰고, 없으면 아래 값으로 떨어진다.
  Vercel 운영에 NEXT_PUBLIC_SUPABASE_URL · NEXT_PUBLIC_SUPABASE_ANON_KEY 가
  둘 다 들어 있는 것을 확인했다(2026-11-12). 아래 값은 그게 빠졌을 때를 위한 보험이다 —
  환경변수만 믿고 바꿨다가 빌드에서 빈 값이 되면 주문 화면이 통째로 멈춘다.

  ⚠️ Next.js 는 NEXT_PUBLIC_* 를 빌드할 때 글자 그대로 바꿔 넣는다.
     process.env.NEXT_PUBLIC_... 를 통째로 적어야 하고, 변수로 돌려 쓰면 안 바뀐다.
*/
const FALLBACK_URL = 'https://ymghmfkqctckxxysxkvy.supabase.co';
const FALLBACK_ANON = 'sb_publishable_3-9zobXqx6Nv36LzmNMBpA_fohZqA5x';

export const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || FALLBACK_URL;
export const SB_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || FALLBACK_ANON;

/** REST 호출에 그대로 붙이는 헤더 */
export const SB_HEADERS = {
  apikey: SB_ANON_KEY,
  Authorization: `Bearer ${SB_ANON_KEY}`,
};
