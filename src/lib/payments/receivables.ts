/**
 * 수금 예정(미수금) 집계 — 결제 내역 → 수금 관리 탭과 정확히 같은 기준.
 * 상태가 잔금 처리 요망·미입금인 결제 중 취소된 프로젝트에 연결된 건은 뺀다.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

export type ReceivablesSummary = { count: number; total: number }

export async function getReceivablesSummary(db: SupabaseClient<Database>): Promise<ReceivablesSummary> {
  const { data, error } = await db
    .from('payments')
    .select('amount, projects(status)')
    .in('status', ['balance_due', 'unpaid'])
  if (error) throw new Error(error.message)

  const rows = ((data ?? []) as unknown as { amount: number; projects: { status: string } | null }[])
    .filter((p) => p.projects?.status !== 'cancelled')
  return {
    count: rows.length,
    total: rows.reduce((s, p) => s + Number(p.amount), 0),
  }
}
