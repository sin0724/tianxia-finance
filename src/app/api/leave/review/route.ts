/**
 * 웹 화면(연차 관리)에서의 승인/반려/취소 처리.
 *
 * 캘린더 이벤트 생성과 Slack 통보는 서버 자격증명이 필요하므로 브라우저에서 직접 하지 않고
 * 이 라우트를 거친다. Slack 버튼과 완전히 같은 reviewLeaveRequest() 를 호출한다.
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { reviewLeaveRequest, type ReviewAction } from '@/lib/leave/review'

export async function POST(request: Request) {
  // 로그인 확인 — 이 라우트는 미들웨어의 /api 예외 대상이라 여기서 직접 검사한다
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 })

  let body: { id?: string; action?: string; memo?: string | null }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '잘못된 요청입니다.' }, { status: 400 })
  }

  const { id, action, memo } = body
  if (!id || !action || !['approve', 'reject', 'cancel'].includes(action)) {
    return Response.json({ error: 'id 와 action(approve/reject/cancel)이 필요합니다.' }, { status: 400 })
  }

  const result = await reviewLeaveRequest(createAdminClient(), {
    id,
    action: action as ReviewAction,
    reviewer: user.email ?? '관리자',
    memo: memo ?? null,
  })

  if (!result.ok) return Response.json({ error: result.message }, { status: 409 })
  return Response.json({ ok: true, message: result.message })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
