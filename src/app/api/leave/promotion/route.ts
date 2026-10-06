/**
 * 연차 사용 촉진 발송 — 하루 한 번 호출한다.
 *
 *   Cron:  POST /api/leave/promotion   (Authorization: Bearer CRON_SECRET)
 *   웹:    연차 관리 → 연차 현황 → "촉진 알림 확인" 버튼 (로그인 세션)
 *
 * 같은 연차연도·차수에는 한 번만 보내므로 여러 번 호출해도 안전하다.
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runLeavePromotions } from '@/lib/leave/promotion'

export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  const hasCronAuth = !!cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`

  if (!hasCronAuth) {
    // 이 라우트는 미들웨어의 /api 예외 대상이라 여기서 직접 검사한다
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 })
  }

  try {
    const results = await runLeavePromotions(createAdminClient())
    return Response.json({ ok: true, sent: results })
  } catch (e) {
    console.error('[leave/promotion] 실패:', e)
    return Response.json({ error: e instanceof Error ? e.message : '알 수 없는 오류' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
