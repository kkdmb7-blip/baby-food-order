import type { Metadata } from 'next';
import { INTRO_FONT_HREF, INTRO_STYLE, BANCHAN_BODY } from '../intro-html';
import { getMenuWeeks } from '@/lib/weeklyMenu';
import { fillBanchanSlots } from '@/lib/introMenuHtml';

export const metadata: Metadata = {
  title: '까꿍디미방 — 수요일 유아식 반찬',
  description:
    '매주 수요일 반찬 다섯 가지와 국 하나. 메뉴표 번호로 바꿔 담으실 수 있고, 반찬마다 들어간 재료를 적습니다. 강서구 화곡동 같은 주방에서 2016년부터 만듭니다.',
  alternates: { canonical: '/banchan' },
};

// 반찬은 주 단위로 바뀐다 — 이유식 페이지(/)와 같은 주기로 다시 그린다
export const revalidate = 600;

/**
 * 유아식 반찬 상세페이지.
 *
 * 이유식 페이지(/)와 같은 원본 HTML 에서 반찬 구간만 남긴 것이다 (scripts/build-intro.mjs).
 * 2026-11-13 둘로 나눴다 — 손님이 다르고(이유식 6~12개월 / 반찬은 밥 먹는 아이),
 * 조미료·원산지·알레르기 고지가 섞여 있었다. 스마트스토어도 상품이 따로라 파일이 둘이다.
 *
 * 그 주 반찬(번호·재료)은 <!--@BANCHAN_MENU--> 자리에 DB 에서 채운다.
 * 번호는 메뉴표 인쇄 순서(lib/banchanOrder) — 손님이 "3번 두 개" 로 주문한다.
 * 재료 탭 스크립트가 없는 페이지라 next/script 는 싣지 않는다.
 */
export default async function BanchanPage() {
  const weeks = await getMenuWeeks();
  const body = fillBanchanSlots(BANCHAN_BODY, { weeks });
  return (
    <>
      {INTRO_FONT_HREF ? <link rel="stylesheet" href={INTRO_FONT_HREF} /> : null}
      <div dangerouslySetInnerHTML={{ __html: INTRO_STYLE + body }} />
    </>
  );
}
