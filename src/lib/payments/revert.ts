/**
 * 입금 확정 되돌리기 — '입금완료'로 잘못 올린 건을 수금 예정(미입금·잔금)으로 돌린다.
 *
 * Slack(버튼·`/결제 취소`)과 웹(결제 내역 화면) 양쪽이 이 함수 하나를 부른다.
 *
 * 시트와 DB를 함께 바꾸는 것이 핵심이다. payments.status 만 바꾸면 다음 sync-sheets 가
 * "미확정 건은 시트가 원본"이라는 규칙에 따라 시트의 '입금완료'를 읽어 다시 confirmed 로
 * 덮어쓴다. 그래서 M열 동기화 ID로 행을 찾아 I열을 먼저 고친다.
 *
 * 프로젝트는 별도로 건드리지 않는다 — 프로젝트 화면의 입금액/수금예정은 payments.status 로
 * 계산하므로 상태만 바뀌면 입금액에서 빠지고 수금 예정으로 옮겨간다.
 * 확정 당시 올라간 projects.total_amount 도 그대로 둔다 (받아야 할 계약금액은 변하지 않는다).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { updateSheetStatusBySyncId, type PaymentStatus as SheetStatus } from '@/lib/google-sheets'

type Admin = SupabaseClient<Database>

/** 되돌린 뒤의 상태 — 수금 관리 탭에 나타나는 두 가지 */
export type RevertStatus = 'unpaid' | 'balance_due'

export const REVERT_STATUS_LABEL: Record<RevertStatus, string> = {
  unpaid: '미입금',
  balance_due: '잔금 처리 요망',
}

/** DB 상태 → 시트 I열 드롭다운 값 (register.ts 의 toDbStatus 와 반대 방향) */
const toSheetStatus = (s: RevertStatus): SheetStatus =>
  s === 'balance_due' ? '잔금처리요망' : '미입금'

export function isRevertStatus(v: unknown): v is RevertStatus {
  return v === 'unpaid' || v === 'balance_due'
}

export type RevertedPayment = {
  id: string
  clientName: string
  amount: number
  paymentDate: string
  manager: string | null
  projectName: string | null
}

export type RevertResult =
  | { ok: true; message: string; warning?: string; payment: RevertedPayment; sheetRow?: number }
  | { ok: false; message: string }

const SUMMARY_SELECT = 'id, status, amount, payment_date, manager, external_id, client_name_raw, projects(name, clients(name))'

type SummaryRow = {
  id: string
  status: string
  amount: number
  payment_date: string
  manager: string | null
  external_id: string | null
  client_name_raw: string | null
  projects: unknown
}

function toSummary(p: SummaryRow): RevertedPayment {
  const rel = p.projects as { name: string; clients: { name: string } | null } | null
  return {
    id: p.id,
    clientName: rel?.clients?.name ?? p.client_name_raw ?? '(상호명 없음)',
    amount: p.amount,
    paymentDate: p.payment_date,
    manager: p.manager,
    projectName: rel?.name ?? null,
  }
}

export async function revertPaymentConfirmation(
  admin: Admin,
  params: { paymentId: string; status: RevertStatus },
): Promise<RevertResult> {
  const { paymentId, status } = params

  const { data: payment } = await admin
    .from('payments')
    .select(SUMMARY_SELECT)
    .eq('id', paymentId)
    .maybeSingle()

  if (!payment) return { ok: false, message: '결제 내역을 찾을 수 없습니다. 이미 삭제됐을 수 있습니다.' }
  if (payment.status !== 'confirmed') {
    return { ok: false, message: '이미 수금 예정 상태인 건입니다. 결제 내역 → 수금 관리 탭에서 확인해주세요.' }
  }

  const summary = toSummary(payment as SummaryRow)

  // ── 1) 시트 I열 먼저 ────────────────────────────────────────────
  // 실패해도 DB 는 되돌린다. 다만 그대로 두면 다음 동기화가 다시 확정시키므로 경고를 반드시 붙인다.
  let warning: string | undefined
  let sheetRow: number | undefined

  const FIX_SHEET_HINT = '시트 I열(입금상태)을 직접 바꿔주세요 — 그대로 두면 다음 동기화 때 다시 입금완료로 돌아갑니다.'

  if (payment.external_id?.startsWith('tx_')) {
    try {
      const found = await updateSheetStatusBySyncId(payment.external_id, toSheetStatus(status))
      if (found) sheetRow = found.rowIndex
      else warning = `시트에서 이 건의 행을 찾지 못했습니다. ${FIX_SHEET_HINT}`
    } catch (e) {
      warning = `시트 수정에 실패했습니다 (${e instanceof Error ? e.message : '알 수 없는 오류'}). ${FIX_SHEET_HINT}`
    }
  } else if (payment.external_id?.startsWith('sheet_')) {
    // 동기화 ID 가 아직 M열에 없는 예전 데이터 — 행을 자동으로 찾을 수 없다
    warning = `시트 동기화 ID 가 없는 예전 데이터라 시트를 자동으로 고치지 못했습니다. ${FIX_SHEET_HINT}`
  }

  // ── 2) DB 상태 ─────────────────────────────────────────────────
  const { error } = await admin
    .from('payments')
    .update({ status })
    .eq('id', paymentId)
    .eq('status', 'confirmed') // 동시에 두 번 눌러도 한 번만 처리

  if (error) return { ok: false, message: `상태 변경 실패: ${error.message}` }

  return {
    ok: true,
    message: `${REVERT_STATUS_LABEL[status]}(으)로 되돌렸습니다. 결제 내역 → 수금 관리 탭에 나타나고 프로젝트 입금액에서 빠집니다.`,
    warning,
    payment: summary,
    sheetRow,
  }
}

/**
 * `/결제 취소` 목록용 — 최근 확정된 결제. Slack static_select 는 100개까지라 그 안에서 자른다.
 * 실수는 대개 방금 올린 건이므로 등록 시각 역순.
 */
export async function fetchRecentConfirmedPayments(admin: Admin, limit = 100): Promise<RevertedPayment[]> {
  const { data } = await admin
    .from('payments')
    .select(SUMMARY_SELECT)
    .eq('status', 'confirmed')
    .order('created_at', { ascending: false })
    .limit(limit)

  return ((data ?? []) as SummaryRow[]).map(toSummary)
}

/** 버튼이 가리키는 건 하나 — 아직 확정 상태일 때만 돌려준다 (이미 되돌렸거나 삭제되면 null) */
export async function fetchConfirmedPayment(admin: Admin, paymentId: string): Promise<RevertedPayment | null> {
  const { data } = await admin
    .from('payments')
    .select(SUMMARY_SELECT)
    .eq('id', paymentId)
    .eq('status', 'confirmed')
    .maybeSingle()

  return data ? toSummary(data as SummaryRow) : null
}
