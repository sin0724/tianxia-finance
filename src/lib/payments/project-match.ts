/**
 * 결제 한 건을 어느 클라이언트·프로젝트에 붙일지 정하는 규칙 — 한 곳에만 둔다.
 *
 * 쓰는 곳: Slack `/결제` 등록(register.ts), 결제시트 동기화의 신규 행(sheets-sync.ts).
 *
 * 규칙
 * - 클라이언트: 이름이 대소문자 무시하고 정확히 같은 곳. 없으면 새로 만든다.
 *   clients.manager 에는 우리 쪽 담당자가 아니라 **거래처 대표자**가 들어간다.
 * - 프로젝트: 잔여가 남은 진행중 → 잔여가 남은 완료(잔금) 순으로 붙인다. 완납된 곳엔 붙이지 않는다.
 *   '추가계약' 상태이거나 메모에 재계약·추가계약 표기가 있으면 무조건 새 프로젝트.
 *   붙인 결과 누적 결제가 계약금액을 넘으면 계약금액을 올린다 (분할 납부·추가 결제 반영).
 * - 새 프로젝트 이름: 처음이면 상호명, 이전 프로젝트가 있으면 "(재계약 N차)" / "(추가계약 N차)".
 *
 * ⚠ 웹 "결제 추가" 폼은 SQL 함수 add_payment_with_auto_project
 *   (supabase/migrations/015_payment_status_sync_logs.sql)를 쓰는데, 그 함수가 이 규칙을 SQL로 따라 한다.
 *   규칙을 바꾸면 그 함수도 같이 고쳐야 한다.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { PaymentStatus } from '@/lib/google-sheets'

type Admin = SupabaseClient<Database>

export type ClientRef = { id: string; name: string }

/**
 * 동기화처럼 여러 행을 한 번에 처리할 때 쓰는 클라이언트 목록 캐시.
 * 주면 DB 조회 대신 이 목록에서 찾고, 새로 만든 클라이언트를 뒤에 덧붙인다.
 */
export type ClientCache = ClientRef[]

export type ProjectCandidate = { id: string; status: string; total_amount: number }

// ── 순수 함수 ────────────────────────────────────────────────────

/** 이름이 대소문자 무시하고 정확히 같은 첫 클라이언트 */
export function findClientByName<T extends ClientRef>(list: readonly T[], name: string): T | undefined {
  const key = name.toLowerCase()
  return list.find((c) => c.name.toLowerCase() === key)
}

/**
 * ILIKE 로 먼저 좁힐 때 쓰는 패턴. `%`·`*`(PostgREST 가 %로 바꾼다)·`\` 는 한 글자 와일드카드 `_` 로 바꿔
 * 원래 이름을 반드시 포함하는 넓은 집합만 가져오고, 정확한 비교는 findClientByName 으로 한다.
 */
export function clientNamePrefilterPattern(name: string): string {
  return name.replace(/[%*\\]/g, '_')
}

/** '추가계약' 상태이거나 메모에 재계약·추가계약 표기가 있으면 기존 프로젝트에 붙이지 않는다 */
export function isForceNewProject(status: PaymentStatus, memo: string): boolean {
  return status === '추가계약' || /재\s*계약|추가\s*계약/.test(memo)
}

/**
 * 붙일 프로젝트 — 잔여가 남은 진행중 → 잔여가 남은 완료. 후보 순서(최근 생성 순)를 그대로 따른다.
 * forceNew 면 null.
 */
export function chooseTargetProject<T extends ProjectCandidate>(
  candidates: readonly T[],
  paidByProject: Readonly<Record<string, number>>,
  forceNew: boolean,
): T | null {
  if (forceNew) return null
  const hasBalance = (p: T) => (paidByProject[p.id] ?? 0) < p.total_amount
  return (
    candidates.find((p) => p.status === 'ongoing' && hasBalance(p)) ??
    candidates.find((p) => p.status === 'completed' && hasBalance(p)) ??
    null
  )
}

/** 프로젝트별 결제 합계 */
export function sumPaidByProject(pays: readonly { project_id: string | null; amount: number }[]): Record<string, number> {
  const paid: Record<string, number> = {}
  for (const pay of pays) {
    if (pay.project_id) paid[pay.project_id] = (paid[pay.project_id] ?? 0) + pay.amount
  }
  return paid
}

/** 새 프로젝트의 이름과 메모. priorCount = 취소 제외 기존 프로젝트 수 */
export function newProjectFields(params: {
  clientName: string
  priorCount: number
  forceNew: boolean
  memo: string
}): { name: string; memo: string | null } {
  const { clientName, priorCount, forceNew, memo } = params
  const isRenewal = priorCount > 0
  const tag = /재\s*계약/.test(memo) ? '재계약' : '추가계약'
  const name = forceNew && isRenewal
    ? `${clientName} (${tag} ${priorCount}차)`
    : isRenewal
      ? `${clientName} (재계약 ${priorCount}차)`
      : clientName
  return {
    name,
    memo: forceNew ? '추가/재계약 (자동 생성)' : isRenewal ? '재계약 (자동 생성)' : null,
  }
}

// ── DB ──────────────────────────────────────────────────────────

/**
 * 클라이언트 조회 또는 생성. cache 를 주면 그 목록에서 찾고 새로 만든 건 덧붙인다.
 * 실패하면 `{ error }` (DB 오류 메시지).
 */
export async function findOrCreateClient(
  admin: Admin,
  params: { name: string; representative: string | null; phone: string | null },
  cache?: ClientCache,
): Promise<{ id: string } | { error: string }> {
  const { name, representative, phone } = params

  let existing: ClientRef | undefined
  if (cache) {
    existing = findClientByName(cache, name)
  } else {
    const { data } = await admin
      .from('clients')
      .select('id, name')
      .ilike('name', clientNamePrefilterPattern(name))
    existing = findClientByName(data ?? [], name)
  }
  if (existing) return { id: existing.id }

  const { data: created, error } = await admin
    .from('clients')
    .insert({ name, manager: representative || null, contact: phone || null })
    .select('id')
    .single()
  if (error || !created) return { error: error?.message ?? '알 수 없는 오류' }

  cache?.push({ id: created.id, name })
  return { id: created.id }
}

/**
 * 프로젝트 조회 또는 생성. 붙일 곳이 있으면 `{ id, isNew: false }`, 새로 만들면 `{ id, isNew: true }`.
 * 생성이 실패하면 `{ error }`.
 */
export async function findOrCreateProject(
  admin: Admin,
  params: { clientId: string; clientName: string; amount: number; date: string; status: PaymentStatus; memo: string },
): Promise<{ id: string; isNew: boolean } | { error: string }> {
  const { clientId, clientName, amount, date, status, memo } = params

  const { data: projs } = await admin
    .from('projects')
    .select('id, status, total_amount')
    .eq('client_id', clientId)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
  const candidates = projs ?? []

  const forceNew = isForceNewProject(status, memo)

  if (!forceNew && candidates.length > 0) {
    const { data: pays } = await admin
      .from('payments')
      .select('project_id, amount')
      .in('project_id', candidates.map((p) => p.id))
    const paidByProject = sumPaidByProject(pays ?? [])

    const target = chooseTargetProject(candidates, paidByProject, false)
    if (target) {
      const newPaidTotal = (paidByProject[target.id] ?? 0) + amount
      if (newPaidTotal > target.total_amount) {
        await admin.from('projects').update({ total_amount: newPaidTotal }).eq('id', target.id)
      }
      return { id: target.id, isNew: false }
    }
  }

  const fields = newProjectFields({ clientName, priorCount: candidates.length, forceNew, memo })
  const { data: created, error } = await admin
    .from('projects')
    .insert({
      client_id: clientId,
      name: fields.name,
      total_amount: amount,
      contract_date: date,
      status: 'ongoing',
      memo: fields.memo,
    })
    .select('id')
    .single()
  if (error || !created) return { error: error?.message ?? '알 수 없는 오류' }
  return { id: created.id, isNew: true }
}
