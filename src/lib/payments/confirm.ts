/**
 * 입금 확정·확정 입금 수정 — 앱이 입금 기록의 유일한 입력 지점.
 *
 * 예전에는 부분 입금을 시트 I열 메모("11/20 입금완료 1,980,000원")와 앱 입금 확정에 두 번 적어
 * 서로 어긋났다. 이제 앱에서 확정하면 시트 메모 줄과 I열 상태를 서버가 함께 고친다.
 * 시트 작업이 실패해도 DB 처리는 그대로 두고 경고만 돌려준다 (revert.ts 와 같은 방식).
 *
 * 잔액의 기준은 앱의 수금 예정(미확정) 금액이다 — 시트 금액(G)으로 다시 계산하지 않는다.
 * 여러 달 계약은 예전 입금이 그룹 밖에 기록돼 있어 "G − 확정 합계"가 실제보다 크게 나오기 때문이다
 * (lib/payments/remaining.ts). 확정 금액을 고치면 그 차액만큼만 수금 예정 금액을 조정한다.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  findRowIndexBySyncId, fetchSheetRowByIndex, appendStatusNote, replaceStatusNoteLine,
  updateSheetStatusByRowIndex,
} from '@/lib/google-sheets'
import { formatDepositNoteLine } from '@/lib/payments/deposit-note'
import { adjustPendingByDelta, baseSyncId, isInSyncGroup, pendingTotal } from '@/lib/payments/remaining'
import { isSameSheetStatus } from '@/lib/payments/status'

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

  const { warning } = await recordDepositOnSheet(admin, {
    externalId: payment.external_id, paymentDate, amount,
  })
  return { ok: true, message, warning, remainder }
}

/**
 * 입금 확정을 시트에 반영 — I열 메모에 입금 줄을 덧붙이고, 앱에 남은 수금 예정 금액으로 I열 상태를 정한다.
 * 수금 관리의 입금 확정과 통장 업로드 자동 매칭이 함께 쓴다. DB 확정(RPC)이 끝난 뒤에 부른다.
 * 절대 throw 하지 않는다 — 실패하면 사람이 시트를 고칠 수 있게 경고 문구를 돌려준다.
 * 시트 동기화 ID(tx_…)가 없는 결제는 아무 것도 하지 않는다.
 */
export async function recordDepositOnSheet(
  admin: Admin,
  params: { externalId: string | null; paymentDate: string; amount: number },
): Promise<{ warning?: string }> {
  const { externalId, paymentDate, amount } = params
  const base = baseSyncId(externalId)
  if (!base) return {}

  let noteLine: string
  try {
    noteLine = formatDepositNoteLine(paymentDate, amount)
  } catch (e) {
    return { warning: `시트 메모 줄을 만들지 못했습니다 (${errMsg(e)}). 시트 I열 메모와 입금상태를 직접 확인해주세요.` }
  }

  const FIX_HINT = `시트 I열 메모에 "${noteLine}" 줄과 입금상태를 직접 확인해주세요.`
  try {
    const rowIndex = await findRowIndexBySyncId(base)
    if (rowIndex == null) return { warning: `시트에서 이 건의 행을 찾지 못했습니다. ${FIX_HINT}` }

    await appendStatusNote(rowIndex, noteLine)

    // 입금상태는 앱에 남은 수금 예정 금액으로 정한다 (보통 RPC 잔여분과 같다)
    const group = await loadSyncGroup(admin, base)
    const remainingPending = pendingTotal(group)
    const nextStatus = remainingPending <= 1 ? '입금완료' : '잔금 처리 요망'
    // 시트가 이미 같은 상태(카드결제완료 포함 완납끼리)면 쓰지 않는다
    const sheetRow = await fetchSheetRowByIndex(rowIndex)
    if (!sheetRow || !isSameSheetStatus(sheetRow.status, nextStatus)) {
      await updateSheetStatusByRowIndex(rowIndex, nextStatus)
    }
    return {}
  } catch (e) {
    return { warning: `시트 수정에 실패했습니다 (${errMsg(e)}). ${FIX_HINT}` }
  }
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

      // 2) 확정 금액이 바뀐 만큼 수금 예정 금액 조정 (시트 G열로 다시 계산하지 않는다)
      const group = await loadSyncGroup(admin, base)
      if (amountChanged) {
        const delta = values.amount - Number(before.amount)
        const pending = group.filter((p) => p.status !== 'confirmed')
        if (pending.length === 1) {
          const adjusted = adjustPendingByDelta(Number(pending[0].amount), delta)
          if (adjusted.ok) {
            const { error: upErr } = await admin.from('payments')
              .update({ amount: adjusted.amount }).eq('id', pending[0].id)
            if (upErr) warnings.push(`잔여분 금액 수정 실패: ${upErr.message}`)
            else pending[0].amount = adjusted.amount
          } else {
            warnings.push(`바뀐 금액(${delta.toLocaleString('ko-KR')}원)이 남은 수금 예정(${Number(pending[0].amount).toLocaleString('ko-KR')}원) 이상이라 잔액을 바꾸지 않았습니다. 수금 관리를 확인해주세요.`)
          }
        } else if (pending.length === 0) {
          if (delta < 0) warnings.push('잔여분이 없어 잔액을 늘리지 않았습니다. 수금 관리를 확인해주세요.')
        } else {
          warnings.push(`이 건의 수금 예정이 ${pending.length}건이라 잔액을 자동으로 맞추지 않았습니다. 수금 관리를 확인해주세요.`)
        }
      }

      // 3) 남은 수금 예정 금액에 따라 I열 상태 — 지금 값과 다를 때만
      const nextStatus = pendingTotal(group) <= 1 ? '입금완료' : '잔금 처리 요망'
      const sheetRow = await fetchSheetRowByIndex(rowIndex)
      if (!sheetRow) {
        warnings.push(`시트 행을 읽지 못해 입금상태를 확인하지 못했습니다. I열이 "${nextStatus}"인지 확인해주세요.`)
      } else if (!isSameSheetStatus(sheetRow.status, nextStatus)) {
        // 완납끼리(입금완료·카드결제완료)는 같다고 본다 — 카드결제완료를 입금완료로 덮어쓰지 않게
        await updateSheetStatusByRowIndex(rowIndex, nextStatus)
      }
    }
  } catch (e) {
    warnings.push(`시트 처리에 실패했습니다 (${errMsg(e)}). 시트 I열 메모와 잔액을 직접 확인해주세요.`)
  }

  return { ok: true, message, warning: warnings.length > 0 ? warnings.join(' ') : undefined }
}
