/**
 * 인센티브 정산 — 한 달 정산표와 재무관리 입금 대조. 관리자만 (아니면 404).
 *
 *   GET /api/incentives?year=2026&month=11            정산표 + 재무관리 입금 대조
 *   GET /api/incentives?year=2026&month=11&finance=0  정산표만 (칸을 고친 뒤 다시 읽을 때)
 */
import { handle, readYm } from '@/lib/incentives/api'
import { loadFinance, loadView } from '@/lib/incentives/server'
import type { ViewResponse } from '@/lib/incentives/types'

export async function GET(request: Request) {
  return handle(async ({ supabase }) => {
    const { year, month } = readYm(request)
    const view = await loadView(supabase, year, month)
    let finance: ViewResponse['finance'] = null
    let financeError: string | null = null
    if (new URL(request.url).searchParams.get('finance') !== '0') {
      try {
        finance = await loadFinance(supabase, view)
      } catch (e) {
        financeError = e instanceof Error ? e.message : String(e)
      }
    }
    return { view, finance, financeError } satisfies ViewResponse
  })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
