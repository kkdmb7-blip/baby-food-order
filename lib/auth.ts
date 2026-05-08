import { cookies } from 'next/headers';

const COOKIE = 'admin_session';
const MAX_AGE = 60 * 60 * 8; // 8시간

export function setAdminSession() {
  cookies().set(COOKIE, '1', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE
  });
}

export function clearAdminSession() {
  cookies().set(COOKIE, '', { path: '/', maxAge: 0 });
}

export function isAdminAuthed(): boolean {
  return cookies().get(COOKIE)?.value === '1';
}
