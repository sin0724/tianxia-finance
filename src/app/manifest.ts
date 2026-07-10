import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '티엔샤 재무관리',
    short_name: '티엔샤 재무',
    description: '티엔샤 코퍼레이션 월별 정산 관리 시스템',
    start_url: '/',
    display: 'standalone',
    background_color: '#f9fafb',
    theme_color: '#111827',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
