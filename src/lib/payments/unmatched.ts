import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

type Client = SupabaseClient<Database>

/**
 * "프로젝트 미연결" 판정 기준 — 사이드바 배지·대시보드 알림·결제 내역 필터가 모두 이걸 쓴다.
 *
 * - project_id 가 유일한 기준이다. matched 컬럼은 project_id 를 갱신하는 경로가 여럿이라
 *   값이 어긋날 수 있어 표시용으로 신뢰하지 않는다.
 * - 확정 입금만 대상 (수금 예정 건은 수금 관리 탭에서 따로 관리)
 * - 집계 제외 건은 연결할 필요가 없으므로 제외 — 안 그러면 없앨 수 없는 숫자가 남는다
 * - 기간 제한 없음 (전체 기간)
 */
export function unmatchedPaymentsQuery(supabase: Client) {
  return supabase
    .from('payments')
    .select('*, projects(name, status, clients(name))')
    .is('project_id', null)
    .eq('status', 'confirmed')
    .eq('excluded', false)
}

export async function countUnmatchedPayments(supabase: Client): Promise<number> {
  const { count } = await supabase
    .from('payments')
    .select('id', { count: 'exact', head: true })
    .is('project_id', null)
    .eq('status', 'confirmed')
    .eq('excluded', false)
  return count ?? 0
}

/** 결제 한 건이 "연결 필요" 상태인지 — 목록 행 표시용 (위 쿼리와 동일 기준) */
export function isUnmatchedPayment(p: {
  project_id: string | null
  status: string
  excluded: boolean
}) {
  return !p.project_id && p.status === 'confirmed' && !p.excluded
}

/** 사이드바 배지 즉시 갱신 요청 */
export function refreshBadges() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('refresh-badges'))
}
