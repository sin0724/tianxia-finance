/**
 * 인센티브 정산 — 달 정산표. 관리자만 (아니면 404).
 *
 *   POST  /api/incentives/months  { year, month }            새 달 정산표를 만들고 CRM 동기화 (정산시트 "새 월 탭 만들기")
 *   PATCH /api/incentives/months  { id, base_salary?, special_allowance?, summary_note? }   I · K · L
 *   PATCH /api/incentives/months  { id, action: 'close' | 'reopen' }                      마감 / 마감 취소
 */
import { z } from 'zod'
import { handle, id, readJson, won, ymSchema } from '@/lib/incentives/api'
import { HttpError, assertOpen, closeMonth, createMonths, syncMonth } from '@/lib/incentives/server'

export async function POST(request: Request) {
  return handle(async ({ supabase }) => {
    const { year, month } = await readJson(request, ymSchema)
    const created = await createMonths(supabase, year, month)
    try {
      return { created, messages: await syncMonth(supabase, year, month), syncError: null }
    } catch (e) {
      return { created, messages: [], syncError: e instanceof Error ? e.message : String(e) }
    }
  })
}

const patchSchema = z.union([
  z.object({ id, action: z.enum(['close', 'reopen']) }),
  z.object({
    id,
    base_salary: won.min(0).optional(),
    special_allowance: won.nullable().optional(),
    summary_note: z.string().max(2000).optional(),
  }),
])

export async function PATCH(request: Request) {
  return handle(async ({ supabase }) => {
    const body = await readJson(request, patchSchema)
    const { data: month, error } = await supabase.from('incentive_months').select('*').eq('id', body.id).maybeSingle()
    if (error) throw new Error(error.message)
    if (!month) throw new HttpError(404, '이 달 정산표가 없습니다.')

    if ('action' in body) {
      if (body.action === 'close') return { month: await closeMonth(supabase, body.id) }
      const { data, error: e } = await supabase.from('incentive_months')
        .update({ status: 'open', closed_at: null }).eq('id', body.id).select('*').single()
      if (e) throw new Error(e.message)
      return { month: data }
    }

    await assertOpen(supabase, month.manager_id, month.year, month.month)
    const patch: { base_salary?: number; special_allowance?: number | null; summary_note?: string } = {}
    if (body.base_salary !== undefined) patch.base_salary = body.base_salary
    if (body.special_allowance !== undefined) patch.special_allowance = body.special_allowance
    if (body.summary_note !== undefined) patch.summary_note = body.summary_note
    const { data, error: e } = await supabase.from('incentive_months').update(patch).eq('id', body.id).select('*').single()
    if (e) throw new Error(e.message)
    return { month: data }
  })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
