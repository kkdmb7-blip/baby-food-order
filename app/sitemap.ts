import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: 'https://kkdmb.picolab.kr/', changeFrequency: 'weekly', priority: 1 },
    { url: 'https://kkdmb.picolab.kr/order', changeFrequency: 'weekly', priority: 1 },
  ];
}
