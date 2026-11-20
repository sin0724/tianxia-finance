/**
 * 인센티브 정산 — 정산 줄 (월 탭 A~G). 관리자만 (아니면 404). 마감한 달은 고치지 않는다.
 *
 *   POST   /api/incentives/lines  { manager_id, year, month, client_name, sales?, paid?, rate?, note?, fill? }  손으로 줄 추가
 *   POST   /api/incentives/lines  { copy: { ids, manager_id, year, month } }                                  지난달 수동 줄 가져오기
 *   PATCH  /api/incentives/lines  { id, client_name?, sales?, paid?, rate?, note?, fill? }
 *   DELETE /api/incentives/lines  { id }
 * P(동기화ID) · Q(CRM 날짜)는 시트처럼 바꾸지 않는다.
 */
import { z } from 'zod'
import { fill, handle, id, readJson, won, ymSchema } from '@/lib/incentives/api'
import { normalizeRateInput } from '@/lib/incentives/engine'
import { HttpError, assertOpen, copyManualLines, nextPosition, type DB } from '@/lib/incentives/server'
import type { Database } from '@/types/database'

const fields = z.object({
  client_name: z.string().trim().min(1, '상호명을 적어 주세요.').max(300),
  sales: won.nullable(),
  paid: won.nullable(),
  rate: z.string().max(500).nullable(),
  note: z.string().max(3000),
  fill,
})

const createSchema = fields.partial().required({ client_name: true }).extend({ manager_id: id, ...ymSchema.shape })
const copySchema = z.object({ copy: z.object({ ids: z.array(id).min(1).max(200), manager_id: id, ...ymSchema.shape }) })

async function lineOf(db: DB, lineId: string) {
  const { data, error } = await db.from('incentive_lines').select('*').eq('id', lineId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new HttpError(404, '줄을 찾을 수 없습니다.')
  await assertOpen(db, data.manager_id, data.year, data.month)
  return data
}

export async function POST(request: Request) {
  return handle(async ({ supabase }) => {
    const body = await readJson(request, z.union([copySchema, createSchema]))
    if ('copy' in body) {
      const { ids, manager_id, year, month } = body.copy
      await assertOpen(supabase, manager_id, year, month)
      return { copied: await copyManualLines(supabase, ids, { managerId: manager_id, year, month }) }
    }
    await assertOpen(supabase, body.manager_id, body.year, body.month)
    const position = await nextPosition(supabase, body.manager_id, body.year, body.month)
    const { data, error } = await supabase.from('incentive_lines').insert({
      manager_id: body.manager_id, year: body.year, month: body.month, position,
      client_name: body.client_name, sales: body.sales ?? null, paid: body.paid ?? null,
      rate: normalizeRateInput(body.rate), note: body.note ?? '', fill: body.fill ?? null, kind: 'manual',
    }).select('*').single()
    if (error) throw new Error(error.message)
    return { line: data }
  })
}

export async function PATCH(request: Request) {
  return handle(async ({ supabase }) => {
    const body = await readJson(request, fields.partial().extend({ id }))
    await lineOf(supabase, body.id)
    const patch: Database['public']['Tables']['incentive_lines']['Update'] = {}
    if (body.client_name !== undefined) patch.client_name = body.client_name
    if (body.sales !== undefined) patch.sales = body.sales
    if (body.paid !== undefined) patch.paid = body.paid
    if (body.rate !== undefined) patch.rate = normalizeRateInput(body.rate)
    if (body.note !== undefined) patch.note = body.note
    if (body.fill !== undefined) patch.fill = body.fill
    const { data, error } = await supabase.from('incentive_lines').update(patch).eq('id', body.id).select('*').single()
    if (error) throw new Error(error.message)
    return { line: data }
  })
}

export async function DELETE(request: Request) {
  return handle(async ({ supabase }) => {
    const body = await readJson(request, z.object({ id }))
    await lineOf(supabase, body.id)
    const { error } = await supabase.from('incentive_lines').delete().eq('id', body.id)
    if (error) throw new Error(error.message)
    return { ok: true }
  })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
