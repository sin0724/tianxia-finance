/**
 * 인센티브 정산 — CRM 결제시트 상황 (읽기만). 관리자만 (아니면 404).
 *   계약별 입금상태 · 작업내용, 지금 동기화하면 생길 줄, 동기화ID가 비어 있는 줄
 *
 *   GET /api/incentives/crm?year=2026&month=11
 */
import { handle, readYm } from '@/lib/incentives/api'
import { loadCrmView, loadView } from '@/lib/incentives/server'
import type { CrmResponse } from '@/lib/incentives/types'

export async function GET(request: Request) {
  return handle(async ({ supabase }) => {
    const { year, month } = readYm(request)
    const view = await loadView(supabase, year, month)
    try {
      return { crm: await loadCrmView(supabase, view), crmError: null } satisfies CrmResponse
    } catch (e) {
      console.error('[incentives/crm]', e)
      return { crm: null, crmError: e instanceof Error ? e.message : String(e) } satisfies CrmResponse
    }
  })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
