/**
 * 결제 수정 — Slack 메시지의 "수정" 버튼으로 시작.
 *
 * 시트와 DB를 함께 업데이트하고, 원본 Slack 메시지에 수정 이력을 추가한다.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchSheetRowBySyncId, updateSheetRowBySyncId, type PaymentStatus } from '@/lib/google-sheets'
import { buildPaymentMemo } from './register'

type Admin = SupabaseClient<Database>

export type EditPaymentInput = {
  date: string
  clientName: string
  representative: string
  phone: string
  manager: string
  amount: number
  memo: string
  status: PaymentStatus
}

export type EditResult = {
  ok: boolean
  message: string
  changes?: { field: string; from: string; to: string }[]
  sheetRow?: number
}

/**
 * 수정 권한 체크.
 * - 원본 등록자 본인
 * - 또는 PAYMENT_EDIT_ADMINS 환경변수에 포함된 Slack user ID
 */
export function canEditPayment(editorUserId: string, registrantUserId: string): boolean {
  if (editorUserId === registrantUserId) return true
  
  const admins = (process.env.PAYMENT_EDIT_ADMINS ?? 'U0AHE6BR86P')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  
  return admins.includes(editorUserId)
}

/**
 * 수정 제약 체크 — 입금 확정 또는 부분 입금 발생 시 금액/날짜 수정 불가.
 */
export async function getEditConstraints(admin: Admin, syncId: string): Promise<{
  canEditAmountDate: boolean
  reason?: string
}> {
  // DB에서 해당 결제 조회
  const { data: payment } = await admin
    .from('payments')
    .select('id, external_id, status, amount, payment_date')
    .eq('external_id', syncId)
    .maybeSingle()

  if (!payment) {
    return { canEditAmountDate: false, reason: '결제 정보를 찾을 수 없습니다.' }
  }

  // 입금 확정 건은 금액/날짜 수정 불가
  if (payment.status === 'confirmed') {
    return {
      canEditAmountDate: false,
      reason: '입금 확정된 건은 금액과 날짜를 수정할 수 없습니다. 다른 필드는 수정 가능합니다.',
    }
  }

  // 부분 입금 발생 여부 체크 (external_id가 syncId로 시작하는 split 건)
  const { data: splits } = await admin
    .from('payments')
    .select('id')
    .like('external_id', `${syncId}#%`)
    .limit(1)

  if (splits && splits.length > 0) {
    return {
      canEditAmountDate: false,
      reason: '부분 입금이 발생한 건은 금액과 날짜를 수정할 수 없습니다. 관리자에게 문의하세요.',
    }
  }

  return { canEditAmountDate: true }
}

/**
 * 변경사항 비교 — 수정 이력 메시지 생성용.
 */
function compareChanges(
  old: EditPaymentInput & { status: PaymentStatus },
  updated: EditPaymentInput,
): { field: string; from: string; to: string }[] {
  const changes: { field: string; from: string; to: string }[] = []

  if (old.date !== updated.date) {
    changes.push({ field: '날짜', from: old.date, to: updated.date })
  }
  if (old.clientName !== updated.clientName) {
    changes.push({ field: '상호명', from: old.clientName, to: updated.clientName })
  }
  if (old.representative !== updated.representative) {
    changes.push({ field: '대표자', from: old.representative, to: updated.representative })
  }
  if (old.phone !== updated.phone) {
    changes.push({ field: '전화번호', from: old.phone, to: updated.phone })
  }
  if (old.manager !== updated.manager) {
    changes.push({ field: '담당자', from: old.manager, to: updated.manager })
  }
  if (old.amount !== updated.amount) {
    const formatKRW = (n: number) => new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' }).format(n)
    changes.push({ field: '금액', from: formatKRW(old.amount), to: formatKRW(updated.amount) })
  }
  if (old.memo !== updated.memo) {
    changes.push({ field: '특이사항', from: old.memo || '(없음)', to: updated.memo || '(없음)' })
  }
  if (old.status !== updated.status) {
    changes.push({ field: '입금상태', from: old.status, to: updated.status })
  }

  return changes
}

/**
 * 결제 수정 — 시트 + DB 업데이트.
 */
export async function editPayment(
  admin: Admin,
  syncId: string,
  input: EditPaymentInput,
  constraints: { canEditAmountDate: boolean },
): Promise<EditResult> {
  const { date, clientName, representative, phone, manager, amount, memo, status } = input

  // ── 1) 시트에서 현재 값 읽기 (fallback: DB) ─────────────────────
  let currentSheet = await fetchSheetRowBySyncId(syncId)
  
  // 시트에 없으면 DB에서 읽기
  if (!currentSheet) {
    const { data: dbPayment } = await admin
      .from('payments')
      .select('payment_date, client_name_raw, amount, manager, memo, status')
      .eq('external_id', syncId)
      .maybeSingle()
    
    if (!dbPayment) {
      return { ok: false, message: '결제 정보를 찾을 수 없습니다.' }
    }

    // DB 메모에서 대표자/전화번호 추출
    const memoMatch = dbPayment.memo?.match(/대표:\s*([^|]+)/) ?? null
    const phoneMatch = dbPayment.memo?.match(/연락처:\s*([^|]+)/) ?? null
    const pureMemo = dbPayment.memo
      ?.replace(/\s*\|\s*대표:[^|]+/, '')
      .replace(/\s*\|\s*연락처:[^|]+/, '')
      .trim() || ''

    const toSheetStatus = (s: string): PaymentStatus =>
      s === 'balance_due' ? '잔금 처리 요망' : s === 'unpaid' ? '미입금' : '입금완료'

    currentSheet = {
      rowIndex: -1, // DB에서 읽은 경우 시트 행 번호 없음
      syncId,
      idCellOccupied: false,
      date: dbPayment.payment_date,
      clientName: dbPayment.client_name_raw || '',
      representative: memoMatch?.[1]?.trim() || '',
      phone: phoneMatch?.[1]?.trim() || '',
      manager: dbPayment.manager || '',
      amount: dbPayment.amount,
      memo: pureMemo,
      status: toSheetStatus(dbPayment.status),
    }
  }

  // ── 2) 변경사항 확인 ─────────────────────────────────────────
  const oldData: EditPaymentInput & { status: PaymentStatus } = {
    date: currentSheet.date,
    clientName: currentSheet.clientName,
    representative: currentSheet.representative,
    phone: currentSheet.phone,
    manager: currentSheet.manager,
    amount: currentSheet.amount,
    memo: currentSheet.memo,
    status: currentSheet.status,
  }

  const changes = compareChanges(oldData, input)
  if (changes.length === 0) {
    return { ok: false, message: '변경사항이 없습니다.' }
  }

  // 제약 체크: 금액/날짜 수정 시도
  if (!constraints.canEditAmountDate) {
    const hasAmountOrDateChange = changes.some((c) => c.field === '금액' || c.field === '날짜')
    if (hasAmountOrDateChange) {
      return {
        ok: false,
        message: '입금 확정되었거나 부분 입금이 발생한 건은 금액과 날짜를 수정할 수 없습니다. 관리자에게 문의하세요.',
      }
    }
  }

  // ── 3) 시트 업데이트 ─────────────────────────────────────────
  let sheetRow: number | undefined
  try {
    const result = await updateSheetRowBySyncId(syncId, {
      date,
      clientName,
      representative,
      phone,
      manager,
      amount,
      memo,
      status,
    })
    sheetRow = result?.rowIndex
  } catch (e) {
    console.error('[payments/edit] 시트 업데이트 실패:', e)
    return {
      ok: false,
      message: `시트 업데이트 실패: ${e instanceof Error ? e.message : '알 수 없는 오류'}`,
    }
  }

  // ── 4) DB 업데이트 ─────────────────────────────────────────
  const toDbStatus = (s: PaymentStatus): 'confirmed' | 'balance_due' | 'unpaid' =>
    s === '잔금 처리 요망' ? 'balance_due' : s === '미입금' ? 'unpaid' : 'confirmed'

  const paymentType = status === '잔금 처리 요망' ? '잔금' : status === '미입금' ? '기타' : null

  const { error: updateErr } = await admin
    .from('payments')
    .update({
      payment_date: date,
      client_name_raw: clientName,
      amount,
      manager: manager || null,
      memo: buildPaymentMemo(memo || null, representative || null, phone || null),
      status: toDbStatus(status),
      payment_type: paymentType,
    })
    .eq('external_id', syncId)

  if (updateErr) {
    return {
      ok: false,
      message: `DB 업데이트 실패: ${updateErr.message}`,
    }
  }

  return {
    ok: true,
    message: '결제가 수정되었습니다.',
    changes,
    sheetRow,
  }
}
