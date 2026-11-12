import type { Metadata } from 'next';
import Script from 'next/script';
import { INTRO_FONT_HREF, INTRO_STYLE, INTRO_BODY, INTRO_SCRIPT } from './intro-html';

export const metadata: Metadata = {
  title: '까꿍디미방 — 아이에게 맞춰주는 수제 이유식',
  description:
    '아이가 안 먹은 재료를 알려주시면 다음 주에 다시 넣어 보내드립니다. 2016년부터 강서구 화곡동 같은 주방에서 만들고, 만든 사람이 직접 상담합니다. 주문 안 하셔도 상담만 하셔도 됩니다.',
  alternates: { canonical: '/' },
};

/**
 * 브랜드 소개(상세페이지).
 *
 * 스마트스토어에 올리는 것과 같은 내용이지만 여기는 자사몰이라
 * 연락처와 주문 동선을 그대로 둔다. 스토어 쪽은 외부 채널·연락처를
 * 직거래 유도로 보기 때문에 그쪽 파일에서만 빼 두었다.
 *
 * 본문·CSS는 app/intro-html.ts 에 문자열로 들어 있다. 원본 HTML에서
 * build-intro.mjs 로 뽑아낸 것이라 여기서 고치지 말고 원본을 고칠 것.
 *
 * 재료 탭 스크립트는 next/script 로 싣는다. innerHTML 에 넣으면
 * 클라이언트 이동으로 들어왔을 때 실행되지 않아 탭이 죽는다.
 */
export default function IntroPage() {
  return (
    <>
      {INTRO_FONT_HREF ? <link rel="stylesheet" href={INTRO_FONT_HREF} /> : null}
      <div dangerouslySetInnerHTML={{ __html: INTRO_STYLE + INTRO_BODY }} />
      <Script id="intro-tabs" strategy="afterInteractive">
        {INTRO_SCRIPT}
      </Script>
    </>
  );
}
