import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

type Client = SupabaseClient<Database>

/**
 * "승인 대기" 판정 기준 — 사이드바 배지와 연차 관리 화면이 모두 이걸 쓴다.
 * status = 'pending' 이 유일한 기준이며 기간 제한은 두지 않는다
 * (지난 날짜라도 처리하지 않으면 없앨 수 없는 숫자가 남기 때문).
 */
export async function countPendingLeaves(supabase: Client): Promise<number> {
  const { count } = await supabase
    .from('leave_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
  return count ?? 0
}
