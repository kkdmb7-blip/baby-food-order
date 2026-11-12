import { cookies } from 'next/headers';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_DAYS } from './sessionToken';

/*
  관리자 로그인 쿠키.

  ⚠️ 전에는 값이 그냥 '1' 이라, 쿠키 하나만 손으로 적으면 비밀번호 없이 관리자 화면·API 가
     다 열렸다(2026-11-13 운영에서 확인). 이제는 '발급시각.서명' 이고 서명은 ADMIN_PASSWORD 로
     만든 HMAC 이다. 계산은 lib/sessionToken.ts(미들웨어용 Web Crypto)와 똑같다 —
     여기는 isAdminAuthed() 를 부르는 30여 곳이 동기 함수라 Node crypto 로 같은 값을 만든다.

  ⚠️ 유지 시간이 8시간이었다. 오후에 로그인하면 밤에 만료돼서, 날짜 버튼을 누르는 순간
     로그인 화면이 떴다("수요일은 왜 오류나?" — 수요일이 아니라 시간이 문제였다). 30일로 늘렸다.
*/
const COOKIE = 'admin_session';
const MAX_AGE = 60 * 60 * 24 * SESSION_DAYS;

function secret(): string {
  return process.env.ADMIN_PASSWORD || '';
}

function sign(issued: string): string {
  return createHmac('sha256', 'kkdmb-admin-session:' + secret()).update(issued).digest('hex');
}

export function setAdminSession() {
  const issued = String(Date.now());
  cookies().set(COOKIE, `${issued}.${sign(issued)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
  });
}

export function clearAdminSession() {
  cookies().set(COOKIE, '', { path: '/', maxAge: 0 });
}

export function isAdminAuthed(): boolean {
  const token = cookies().get(COOKIE)?.value || '';
  if (!secret()) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const issued = token.slice(0, dot);
  const t = Number(issued);
  const now = Date.now();
  if (!Number.isFinite(t) || t > now + 60_000 || now - t > MAX_AGE * 1000) return false;
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(sign(issued));
  return a.length === b.length && timingSafeEqual(a, b);
}
