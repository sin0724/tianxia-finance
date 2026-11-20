import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { slackOptions } from '@/lib/incentives/owners'

/**
 * Slack /결제 담당자 목록 — 인센티브 정산 설정의 담당자 매핑에서 담당자마다 적은 'Slack 결제 담당자' 이름.
 * 아무도 적지 않았거나 읽지 못하면 fallback(예전 고정 목록)을 써서 /결제 창이 멈추지 않게 한다.
 * Slack 요청에는 로그인 세션이 없으므로 서비스 키 클라이언트로 읽는다 (인센티브 표는 관리자 전용 RLS).
 */
export async function paymentOwnerOptions(admin: SupabaseClient<Database>, fallback: string[]): Promise<string[]> {
  try {
    const { data, error } = await admin.from('incentive_managers')
      .select('name, sort_order, active, slack_names').eq('active', true).order('sort_order').order('name')
    if (error) throw new Error(error.message)
    const names = slackOptions(data ?? [])
    return names.length ? names : fallback
  } catch (e) {
    console.error('[slack/payment] 담당자 목록을 읽지 못해 기본 목록을 씁니다:', e instanceof Error ? e.message : e)
    return fallback
  }
}
