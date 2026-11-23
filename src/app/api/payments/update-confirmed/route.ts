/**
 * 웹 화면(결제 내역 → 입금 내역 → 수정)에서의 결제 수정.
 *
 * 확정 입금의 금액·입금일이 바뀌면 시트 I열 메모의 입금 줄을 고치고, 같은 시트 행의
 * 잔여분(수금 예정) 금액을 바뀐 차액만큼 조정한다 — 시트 자격증명이 필요해 서버 라우트를 거친다.
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateConfirmedPayment, type ConfirmedPaymentUpdate } from '@/lib/payments/confirm'

const PAYMENT_TYPES = ['계약금', '중도금', '잔금', '기타'] as const
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

export async function POST(request: Request) {
  // 로그인 확인 — 이 라우트는 미들웨어의 /api 예외 대상이라 여기서 직접 검사한다
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '잘못된 요청입니다.' }, { status: 400 })
  }

  const id = typeof body.id === 'string' ? body.id : ''
  const amount = Number(body.amount)
  if (!id || !Number.isFinite(amount) || !isDate(body.payment_date)) {
    return Response.json({ error: 'id, amount, payment_date(YYYY-MM-DD)가 필요합니다.' }, { status: 400 })
  }
  const paymentType = PAYMENT_TYPES.find((t) => t === body.payment_type) ?? null

  const values: ConfirmedPaymentUpdate = {
    project_id: strOrNull(body.project_id),
    amount,
    payment_date: body.payment_date,
    payment_type: paymentType,
    manager: strOrNull(body.manager),
    memo: strOrNull(body.memo),
    client_name_raw: typeof body.client_name_raw === 'string' ? body.client_name_raw.trim() || null : null,
  }

  const result = await updateConfirmedPayment(createAdminClient(), id, values)
  if (!result.ok) return Response.json({ error: result.message }, { status: result.status })
  return Response.json({ ok: true, message: result.message, warning: result.warning ?? null })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
