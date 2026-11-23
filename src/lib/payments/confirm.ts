/**
 * 입금 확정·확정 입금 수정 — 앱이 입금 기록의 유일한 입력 지점.
 *
 * 예전에는 부분 입금을 시트 I열 메모("11/20 입금완료 1,980,000원")와 앱 입금 확정에 두 번 적어
 * 서로 어긋났다. 이제 앱에서 확정하면 시트 메모 줄과 I열 상태를 서버가 함께 고친다.
 * 시트 작업이 실패해도 DB 처리는 그대로 두고 경고만 돌려준다 (revert.ts 와 같은 방식).
 *
 * 잔액은 "시트 금액(G) − 확정 입금 합계"로 매번 다시 계산한다 (lib/payments/remaining.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  findRowIndexBySyncId, fetchSheetRowByIndex, appendStatusNote, replaceStatusNoteLine,
  updateSheetStatusByRowIndex,
} from '@/lib/google-sheets'
import { formatDepositNoteLine } from '@/lib/payments/deposit-note'
import { baseSyncId, computeRemaining, isInSyncGroup } from '@/lib/payments/remaining'

type Admin = SupabaseClient<Database>
type PaymentRow = Database['public']['Tables']['payments']['Row']

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '알 수 없는 오류')

/** 시트 행 하나에 묶인 결제 전부 — 원래 건(external_id = base) + 잔여분(`base#xxxx`) */
export async function loadSyncGroup(admin: Admin, base: string): Promise<PaymentRow[]> {
  // LIKE 의 _ 는 한 글자 와일드카드라 넉넉히 가져온 뒤 정확히 거른다
  const { data, error } = await admin.from('payments').select('*').like('external_id', `${base}%`)
  if (error) throw new Error(error.message)
  return (data ?? []).filter((p) => isInSyncGroup(p.external_id, base))
}

// ── 입금 확정 (수금 관리 → 입금 확정) ─────────────────────────────

export type ConfirmResult =
  | { ok: true; message: string; warning?: string; remainder: number }
  | { ok: false; status: number; message: string }

export async function confirmPayment(
  admin: Admin,
  params: { paymentId: string; amount: number; paymentDate: string; projectId: string | null },
): Promise<ConfirmResult> {
  const { paymentId, amount, paymentDate, projectId } = params

  const { data: payment } = await admin
    .from('payments').select('id, status, external_id').eq('id', paymentId).maybeSingle()
  if (!payment) return { ok: false, status: 404, message: '결제 내역을 찾을 수 없습니다. 이미 삭제됐을 수 있습니다.' }
  if (payment.status !== 'balance_due' && payment.status !== 'unpaid') {
    return { ok: false, status: 400, message: '이미 입금 확정된 건입니다.' }
  }

  const { data, error } = await admin.rpc('confirm_pending_payment', {
    p_payment_id: paymentId,
    p_amount: amount,
    p_payment_date: paymentDate,
    p_project_id: projectId,
  })
  if (error) return { ok: false, status: 500, message: `처리 실패: ${error.message}` }
  const remainder = Number((data as { remainder?: number } | null)?.remainder ?? 0)

  const message = remainder > 0.01
    ? '입금 확정. 잔여분은 수금 관리에 남습니다.'
    : '입금 확정 처리되었습니다. 입금액에 반영됩니다.'

  // ── 시트: I열 메모에 입금 줄 + 잔액에 따라 I열 상태 ───────────────
  const base = baseSyncId(payment.external_id)
  if (!base) return { ok: true, message, remainder }

  const FIX_HINT = `시트 I열 메모에 "${formatDepositNoteLine(paymentDate, amount)}" 줄과 입금상태를 직접 확인해주세요.`
  let warning: string | undefined
  try {
    const rowIndex = await findRowIndexBySyncId(base)
    if (rowIndex == null) {
      warning = `시트에서 이 건의 행을 찾지 못했습니다. ${FIX_HINT}`
    } else {
      await appendStatusNote(rowIndex, formatDepositNoteLine(paymentDate, amount))

      const sheetRow = await fetchSheetRowByIndex(rowIndex)
      if (!sheetRow) {
        warning = `시트 금액(G열)을 읽지 못해 입금상태를 바꾸지 않았습니다. ${FIX_HINT}`
      } else {
        const group = await loadSyncGroup(admin, base)
        const remaining = computeRemaining(sheetRow.amount, group)
        await updateSheetStatusByRowIndex(rowIndex, remaining <= 1 ? '입금완료' : '잔금 처리 요망')
      }
    }
  } catch (e) {
    warning = `시트 수정에 실패했습니다 (${errMsg(e)}). ${FIX_HINT}`
  }

  return { ok: true, message, warning, remainder }
}

// ── 확정 입금 수정 (입금 내역 → 수정) ─────────────────────────────

export type ConfirmedPaymentUpdate = {
  project_id: string | null
  amount: number
  payment_date: string
  payment_type: PaymentRow['payment_type']
  manager: string | null
  memo: string | null
  client_name_raw: string | null
}

export type UpdateConfirmedResult =
  | { ok: true; message: string; warning?: string }
  | { ok: false; status: number; message: string }

export async function updateConfirmedPayment(
  admin: Admin,
  paymentId: string,
  values: ConfirmedPaymentUpdate,
): Promise<UpdateConfirmedResult> {
  const { data: before } = await admin.from('payments').select('*').eq('id', paymentId).maybeSingle()
  if (!before) return { ok: false, status: 404, message: '결제 내역을 찾을 수 없습니다. 이미 삭제됐을 수 있습니다.' }

  const { error } = await admin.from('payments').update({
    ...values,
    matched: !!values.project_id,
  }).eq('id', paymentId)
  if (error) return { ok: false, status: 500, message: error.message }

  const message = '수정되었습니다.'
  const base = baseSyncId(before.external_id)
  const amountChanged = Number(before.amount) !== values.amount
  const dateChanged = before.payment_date !== values.payment_date
  if (before.status !== 'confirmed' || !base || (!amountChanged && !dateChanged)) {
    return { ok: true, message }
  }

  const warnings: string[] = []
  try {
    const rowIndex = await findRowIndexBySyncId(base)
    if (rowIndex == null) {
      warnings.push('시트에서 이 건의 행을 찾지 못해 시트 메모와 잔액을 고치지 못했습니다.')
    } else {
      // 1) I열 메모의 예전 입금 줄을 새 값으로
      const result = await replaceStatusNoteLine(
        rowIndex,
        formatDepositNoteLine(before.payment_date, Number(before.amount)),
        formatDepositNoteLine(values.payment_date, values.amount),
      )
      if (result === 'appended') {
        warnings.push('시트 메모에서 예전 입금 줄을 찾지 못해 새 줄을 덧붙였습니다. 시트 I열 메모를 확인해주세요.')
      }

      // 2) 잔여분 금액 다시 계산
      const sheetRow = await fetchSheetRowByIndex(rowIndex)
      if (!sheetRow) {
        warnings.push('시트 금액(G열)을 읽지 못해 잔액을 다시 계산하지 못했습니다.')
      } else {
        const group = await loadSyncGroup(admin, base)
        const pending = group.filter((p) => p.status !== 'confirmed')
        const remaining = computeRemaining(sheetRow.amount, group)
        if (pending.length === 1) {
          if (remaining > 0) {
            if (Math.abs(Number(pending[0].amount) - remaining) > 0.01) {
              const { error: upErr } = await admin.from('payments')
                .update({ amount: remaining }).eq('id', pending[0].id)
              if (upErr) warnings.push(`잔여분 금액 수정 실패: ${upErr.message}`)
            }
          } else {
            warnings.push(`확정 입금 합계가 시트 금액 이상입니다 (잔액 ${remaining.toLocaleString('ko-KR')}원). 남은 수금 예정 건을 직접 확인해주세요.`)
          }
        } else if (pending.length > 1) {
          warnings.push(`이 건의 수금 예정이 ${pending.length}건이라 잔액(${remaining.toLocaleString('ko-KR')}원)을 자동으로 맞추지 않았습니다. 직접 확인해주세요.`)
        }
      }
    }
  } catch (e) {
    warnings.push(`시트 처리에 실패했습니다 (${errMsg(e)}). 시트 I열 메모와 잔액을 직접 확인해주세요.`)
  }

  return { ok: true, message, warning: warnings.length > 0 ? warnings.join(' ') : undefined }
}
