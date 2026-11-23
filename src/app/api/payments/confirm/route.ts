/**
 * 웹 화면(결제 내역 → 수금 관리)에서의 입금 확정.
 *
 * 시트 I열 메모·입금상태까지 함께 고쳐야 해서 서버 자격증명이 필요하다 — 그래서 브라우저에서
 * confirm_pending_payment 를 직접 부르지 않고 이 라우트를 거친다.
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { confirmPayment } from '@/lib/payments/confirm'

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

export async function POST(request: Request) {
  // 로그인 확인 — 이 라우트는 미들웨어의 /api 예외 대상이라 여기서 직접 검사한다
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 })

  let body: { id?: string; amount?: number; paymentDate?: string; projectId?: string | null }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '잘못된 요청입니다.' }, { status: 400 })
  }

  const { id, paymentDate } = body
  const amount = Number(body.amount)
  if (!id || !Number.isFinite(amount) || amount <= 0 || !isDate(paymentDate)) {
    return Response.json({ error: 'id, amount(양수), paymentDate(YYYY-MM-DD)가 필요합니다.' }, { status: 400 })
  }

  const result = await confirmPayment(createAdminClient(), {
    paymentId: id,
    amount,
    paymentDate,
    projectId: body.projectId || null,
  })

  if (!result.ok) return Response.json({ error: result.message }, { status: result.status })
  return Response.json({
    ok: true, message: result.message, warning: result.warning ?? null, remainder: result.remainder,
  })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
