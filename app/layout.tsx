import type { Metadata, Viewport } from 'next';
import './globals.css';

const SITE_URL = 'https://kkdmb.picolab.kr';
const STORE_NAME = process.env.NEXT_PUBLIC_STORE_NAME || '까꿍디미방';

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
  maximumScale: 1,
  userScalable: false,
  themeColor: '#e88936'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="bg-brand-50 min-h-screen text-stone-800 antialiased">{children}</body>
    </html>
  );
}
