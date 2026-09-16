/**
 * 결제 등록 — 구글 시트 기재 + payments 저장을 한 번에 처리한다.
 *
 * 중복 방지가 이 파일의 핵심이다.
 * 시트에 행을 추가할 때 M열에 동기화 ID(`tx_...`)를 함께 남기고,
 * 같은 ID를 payments.external_id 로 저장한다. 그러면 나중에 sync-sheets 가
 * 이 행을 읽어도 `byExternalId` 매칭에 걸려 "이미 있는 건"으로 처리되고
 * 결제가 두 번 생기지 않는다.
 *
 * 시트 기재에 실패해도 결제는 저장한다. 다만 그 경우 ID가 없으므로
 * 나중에 같은 내용을 시트에 손으로 적으면 중복될 수 있어 결과에 경고를 담아 돌려준다.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { appendSheetRow, makeSyncId, type PaymentStatus } from '@/lib/google-sheets'

type Admin = SupabaseClient<Database>

export type PaymentInput = {
  date: string           // YYYY-MM-DD
  clientName: string     // 상호명
  representative: string // 거래처 대표자
  phone: string          // 거래처 전화번호
  manager: string        // 우리 쪽 영업 담당자
  amount: number
  memo: string
  status: PaymentStatus
}

/**
 * 시트 행 → payments.memo 문자열.
 *
 * sync-sheets 도 반드시 이 함수를 써야 한다. 형식이 어긋나면 동기화가 매번
 * "메모가 바뀌었다"고 판단해 같은 건을 계속 업데이트한다.
 */
export function buildPaymentMemo(memo: string | null, representative: string | null, phone: string | null): string | null {
  const parts = [
    memo,
    representative ? `대표: ${representative}` : '',
    phone ? `연락처: ${phone}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' | ') : null
}

export type RegisterResult = {
  ok: boolean
  message: string
  /** 시트 기재 실패 등 저장은 됐지만 알려야 할 문제 */
  warning?: string
  projectCreated?: boolean
  sheetRow?: number
  /** 저장된 payments.id — Slack 안내 메시지의 "되돌리기" 버튼이 이 ID 를 들고 있다 */
  paymentId?: string
}

const toDbStatus = (s: PaymentStatus): 'confirmed' | 'balance_due' | 'unpaid' =>
  s === '잔금처리요망' ? 'balance_due' : s === '미입금' ? 'unpaid' : 'confirmed'

/**
 * 클라이언트 조회 또는 생성.
 *
 * clients.manager 에는 우리 쪽 영업 담당자가 아니라 **거래처 대표자**가 들어간다.
 * sync-sheets 가 그렇게 넣고 있어 기준을 맞춘 것이다 (우리 담당자는 payments.manager 에 남는다).
 */
async function findOrCreateClient(
  admin: Admin,
  name: string,
  representative: string,
  phone: string,
): Promise<string | null> {
  const { data: existing } = await admin
    .from('clients')
    .select('id')
    .ilike('name', name)
    .limit(1)
    .maybeSingle()

  if (existing) return existing.id

  const { data: created } = await admin
    .from('clients')
    .insert({ name, manager: representative || null, contact: phone || null })
    .select('id')
    .single()

  return created?.id ?? null
}

/**
 * 프로젝트 조회 또는 생성 — sync-sheets 와 같은 기준을 따른다.
 * 잔여가 남은 프로젝트(진행중 우선 → 완료의 잔금)에만 합치고, 완납된 곳엔 붙이지 않는다.
 * '추가계약' 상태이거나 메모에 재계약·추가계약 표기가 있으면 무조건 새 프로젝트로 분리한다.
 */
async function findOrCreateProject(
  admin: Admin,
  params: { clientId: string; clientName: string; amount: number; date: string; status: PaymentStatus; memo: string },
): Promise<{ id: string; isNew: boolean } | null> {
  const { clientId, clientName, amount, date, status, memo } = params

  const { data: projs } = await admin
    .from('projects')
    .select('id, status, total_amount')
    .eq('client_id', clientId)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })

  const candidates = projs ?? []

  const memoRenewal = /재\s*계약|추가\s*계약/.test(memo)
  const forceNew = status === '추가계약' || memoRenewal

  if (!forceNew && candidates.length > 0) {
    const { data: pays } = await admin
      .from('payments')
      .select('project_id, amount')
      .in('project_id', candidates.map((p) => p.id))

    const paidByProject: Record<string, number> = {}
    for (const pay of pays ?? []) {
      if (pay.project_id) paidByProject[pay.project_id] = (paidByProject[pay.project_id] ?? 0) + pay.amount
    }

    const target =
      candidates.find((p) => p.status === 'ongoing' && (paidByProject[p.id] ?? 0) < p.total_amount) ??
      candidates.find((p) => p.status === 'completed' && (paidByProject[p.id] ?? 0) < p.total_amount)

    if (target) {
      // 누적 결제가 계약금액을 넘으면 총액을 올려둔다 (분할 납부·추가 결제 반영)
      const newPaidTotal = (paidByProject[target.id] ?? 0) + amount
      if (newPaidTotal > target.total_amount) {
        await admin.from('projects').update({ total_amount: newPaidTotal }).eq('id', target.id)
      }
      return { id: target.id, isNew: false }
    }
  }

  const priorCount = candidates.length
  const isRenewal = priorCount > 0
  const tag = /재\s*계약/.test(memo) ? '재계약' : '추가계약'
  const projectName = forceNew && isRenewal
    ? `${clientName} (${tag} ${priorCount}차)`
    : isRenewal
      ? `${clientName} (재계약 ${priorCount}차)`
      : clientName

  const { data: created } = await admin
    .from('projects')
    .insert({
      client_id: clientId,
      name: projectName,
      total_amount: amount,
      contract_date: date,
      status: 'ongoing',
      memo: forceNew ? '추가/재계약 (자동 생성)' : isRenewal ? '재계약 (자동 생성)' : null,
    })
    .select('id')
    .single()

  return created ? { id: created.id, isNew: true } : null
}

export function formatKRW(n: number): string {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' }).format(n)
}

/** 결제 한 건을 시트와 DB 양쪽에 등록한다 */
export async function registerPayment(admin: Admin, input: PaymentInput): Promise<RegisterResult> {
  const { date, clientName, representative, phone, manager, amount, memo, status } = input

  // ── 1) 시트에 먼저 기재하고 동기화 ID를 확보 ─────────────────────
  // 시트가 팀의 원장이므로 여기부터 남긴다. 실패해도 DB 저장은 계속한다.
  let syncId: string
  let sheetRow: number | undefined
  let warning: string | undefined

  try {
    const appended = await appendSheetRow({
      date, clientName, representative, phone, manager, amount, memo, status,
    })
    syncId = appended.syncId
    sheetRow = appended.rowIndex
  } catch (e) {
    syncId = makeSyncId()
    warning = `시트 기재에 실패했습니다 (${e instanceof Error ? e.message : '알 수 없는 오류'}). 결제는 앱에 저장되었으니 시트에는 직접 적어주세요.`
  }

  // ── 2) 클라이언트 / 프로젝트 연결 ────────────────────────────────
  const clientId = await findOrCreateClient(admin, clientName, representative, phone)
  if (!clientId) {
    return { ok: false, message: '클라이언트 저장에 실패했습니다. 관리자에게 문의해주세요.', warning }
  }

  const project = await findOrCreateProject(admin, { clientId, clientName, amount, date, status, memo })

  // ── 3) 결제 저장 ────────────────────────────────────────────────
  const paymentType = status === '잔금처리요망' ? '잔금' : status === '미입금' ? '기타' : null

  const { data: inserted, error: insertErr } = await admin.from('payments').insert({
    project_id: project?.id ?? null,
    amount,
    payment_date: date,
    payment_type: paymentType,
    manager: manager || null,
    // sync-sheets 와 같은 형식이어야 다음 동기화에서 "변경됨"으로 오인하지 않는다
    memo: buildPaymentMemo(memo || null, representative || null, phone || null),
    source: 'slack',
    external_id: syncId,   // 시트 M열과 같은 ID — sync-sheets 가 중복 생성하지 않게 하는 열쇠
    client_name_raw: clientName,
    matched: !!project,
    status: toDbStatus(status),
  }).select('id').single()

  if (insertErr) {
    return { ok: false, message: `결제 저장 실패: ${insertErr.message}`, warning }
  }

  return {
    ok: true,
    message: '결제가 등록되었습니다.',
    warning,
    projectCreated: project?.isNew ?? false,
    sheetRow,
    paymentId: inserted?.id,
  }
}
