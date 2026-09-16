/**
 * 웹 화면(결제 내역)에서의 입금 확정 되돌리기.
 *
 * 구글 시트 I열까지 함께 고쳐야 하는데 그건 서버 자격증명이 필요하므로 브라우저에서
 * payments.status 만 바꾸지 않고 이 라우트를 거친다. Slack 버튼과 같은
 * revertPaymentConfirmation() 을 호출한다.
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revertPaymentConfirmation, isRevertStatus } from '@/lib/payments/revert'

export async function POST(request: Request) {
  // 로그인 확인 — 이 라우트는 미들웨어의 /api 예외 대상이라 여기서 직접 검사한다
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 })

  let body: { id?: string; status?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '잘못된 요청입니다.' }, { status: 400 })
  }

  const { id, status } = body
  if (!id || !isRevertStatus(status)) {
    return Response.json({ error: 'id 와 status(unpaid/balance_due)가 필요합니다.' }, { status: 400 })
  }

  const result = await revertPaymentConfirmation(createAdminClient(), { paymentId: id, status })

  if (!result.ok) return Response.json({ error: result.message }, { status: 409 })
  return Response.json({ ok: true, message: result.message, warning: result.warning ?? null })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
