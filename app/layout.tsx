import type { Metadata, Viewport } from 'next';
import './globals.css';

const SITE_URL = 'https://kkdmb.picolab.kr';
const STORE_NAME = (process.env.NEXT_PUBLIC_STORE_NAME || '까꿍디미방').trim();

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${STORE_NAME} — 신선한 이유식 주문·배송`, template: `%s · ${STORE_NAME}` },
  description: '중기·후기·완료기 단계별 맞춤 이유식을 신선하게 집까지 배송해 드려요. 알레르기 관리, 정기배송, 당일·직배송 지역 지원.',
  keywords: ['이유식', '이유식주문', '이유식배송', '아기이유식', '중기이유식', '후기이유식', STORE_NAME],
  formatDetection: { telephone: false },
  openGraph: {
    type: 'website',
    locale: 'ko_KR',
    siteName: STORE_NAME,
    title: `${STORE_NAME} — 신선한 이유식 주문·배송`,
    description: '단계별 맞춤 이유식을 신선하게 집까지. 알레르기 관리·정기배송 지원.',
    url: SITE_URL,
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: STORE_NAME }],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${STORE_NAME} — 신선한 이유식 주문·배송`,
    images: ['/og-image.png'],
  },
  robots: { index: true, follow: true },
  icons: {
    icon: [{ url: '/favicon.png', type: 'image/png' }],
    apple: [{ url: '/apple-touch-icon.png' }],
  },
  appleWebApp: { capable: true, statusBarStyle: 'default', title: STORE_NAME },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // 확대를 막아두면 시력이 불편한 분이 글씨를 키울 수 없다(접근성 위반).
  // iOS 입력창 자동확대는 globals.css에서 input font-size:16px로 이미 막고 있어서
  // userScalable을 열어도 폼이 튀지 않는다.
  maximumScale: 5,
  userScalable: true,
  themeColor: '#e88936'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        {/* tailwind.config에 Pretendard가 지정돼 있는데 정작 폰트를 불러오는 코드가 없어서
            그동안 시스템 기본 글꼴로 표시됐음. 한글 자간·굵기가 확연히 달라지는 부분이라 로드해준다.
            (dynamic-subset = 화면에 쓰인 글자만 내려받아 용량 부담이 거의 없음) */}
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="" />
        <link
          rel="stylesheet"
          as="style"
          crossOrigin=""
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.css"
        />
      </head>
      <body className="bg-brand-50 min-h-screen text-stone-800 antialiased">{children}</body>
    </html>
  );
}
