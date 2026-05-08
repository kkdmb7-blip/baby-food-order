'use client';
import { useEffect } from 'react';

// 페이지 진입 시 자동 인쇄 다이얼로그 — 사용자가 빠르게 처리할 수 있게
export default function PrintAuto() {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, []);
  return null;
}
