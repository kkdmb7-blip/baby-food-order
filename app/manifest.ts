import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  const storeName = process.env.NEXT_PUBLIC_STORE_NAME || '까꿍디미방';
  return {
    name: storeName,
    short_name: storeName,
    description: '신선한 이유식을 집까지 배송해 드립니다',
    start_url: '/order',
    display: 'standalone',
    background_color: '#fffaf3',
    theme_color: '#e88936',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
