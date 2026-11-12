/*
  관리자 로그인 쿠키에 넣는 '서명된 표'. 서버(Node)와 미들웨어(Edge) 양쪽에서 쓰므로
  Node 전용 모듈 없이 Web Crypto(crypto.subtle) 만 쓴다.

  ⚠️ 전에는 쿠키 값이 그냥 '1' 이었다. 브라우저에서 쿠키 하나만 손으로 적으면 비밀번호 없이
     관리자 화면과 API(주문 수정·고객 명단·주소)가 다 열렸다 — 2026-11-13 운영에서 확인했다.
     이제는 '발급시각.서명' 이고, 서명은 ADMIN_PASSWORD 로 만든 HMAC 이라 비밀번호를 모르면
     만들 수 없다. 비밀번호를 바꾸면 그전 쿠키는 전부 무효가 된다.
*/
const enc = new TextEncoder();
export const SESSION_DAYS = 30;
const MAX_AGE_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode('kkdmb-admin-session:' + secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 길이가 같은지 먼저 보고, 글자마다 비교 시간이 같게 */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeSessionToken(secret: string, now = Date.now()): Promise<string> {
  const issued = String(now);
  return `${issued}.${await hmac(secret, issued)}`;
}

export async function verifySessionToken(token: string | undefined | null, secret: string, now = Date.now()): Promise<boolean> {
  if (!token || !secret) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const issued = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const t = Number(issued);
  if (!Number.isFinite(t) || t > now + 60_000 || now - t > MAX_AGE_MS) return false;
  return sameText(sig, await hmac(secret, issued));
}
