/**
 * 인센티브 정산 — CRM 동기화 (정산시트 메뉴 "특정 월 전체 동기화"). 관리자만 (아니면 404).
 * CRM은 읽기만 하고, 정산표가 있고 마감하지 않은 담당자 달에만 줄을 더한다.
 *
 *   POST /api/incentives/sync   { year, month }
 */
import { handle, readJson, ymSchema } from '@/lib/incentives/api'
import { syncMonth } from '@/lib/incentives/server'

export async function POST(request: Request) {
  return handle(async ({ supabase }) => {
    const { year, month } = await readJson(request, ymSchema)
    return { messages: await syncMonth(supabase, year, month) }
  })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
