/**
 * 인센티브 정산 — 환수내역. 관리자만 (아니면 404). 마감한 달은 고치지 않는다.
 *   D 환수액(직접입력)이 있으면 그 값, 없으면 E 계약금액 · H 진행률로 계산한다 (계산은 화면 · 마감 때).
 *
 *   POST   /api/incentives/clawbacks  { manager_id, year, month, client_name, direct_amount?, contract_amount?, progress?, memo?, registered_on? }
 *   PATCH  /api/incentives/clawbacks  { id, ...같은 칸 }
 *   DELETE /api/incentives/clawbacks  { id }
 */
import { z } from 'zod'
import { handle, id, readJson, won, ymSchema } from '@/lib/incentives/api'
import { HttpError, assertOpen, type DB } from '@/lib/incentives/server'
import type { Database } from '@/types/database'

const fields = z.object({
  client_name: z.string().trim().min(1, '상호명을 적어 주세요.').max(300),
  direct_amount: won.nullable(),
  contract_amount: won.nullable(),
  progress: z.number().min(0).max(100).nullable(),
  memo: z.string().max(3000),
  registered_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
})

const todayKst = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)

async function clawbackOf(db: DB, rowId: string) {
  const { data, error } = await db.from('incentive_clawbacks').select('*').eq('id', rowId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new HttpError(404, '환수 줄을 찾을 수 없습니다.')
  await assertOpen(db, data.manager_id, data.year, data.month)
  return data
}

export async function POST(request: Request) {
  return handle(async ({ supabase }) => {
    const body = await readJson(request, fields.partial().required({ client_name: true }).extend({ manager_id: id, ...ymSchema.shape }))
    await assertOpen(supabase, body.manager_id, body.year, body.month)
    const { data, error } = await supabase.from('incentive_clawbacks').insert({
      manager_id: body.manager_id, year: body.year, month: body.month, client_name: body.client_name,
      direct_amount: body.direct_amount ?? null, contract_amount: body.contract_amount ?? null,
      progress: body.progress ?? null, memo: body.memo ?? '', registered_on: body.registered_on ?? todayKst(),
    }).select('*').single()
    if (error) throw new Error(error.message)
    return { clawback: data }
  })
}

export async function PATCH(request: Request) {
  return handle(async ({ supabase }) => {
    const body = await readJson(request, fields.partial().extend({ id }))
    await clawbackOf(supabase, body.id)
    const patch: Database['public']['Tables']['incentive_clawbacks']['Update'] = {}
    if (body.client_name !== undefined) patch.client_name = body.client_name
    if (body.direct_amount !== undefined) patch.direct_amount = body.direct_amount
    if (body.contract_amount !== undefined) patch.contract_amount = body.contract_amount
    if (body.progress !== undefined) patch.progress = body.progress
    if (body.memo !== undefined) patch.memo = body.memo
    if (body.registered_on !== undefined) patch.registered_on = body.registered_on
    const { data, error } = await supabase.from('incentive_clawbacks').update(patch).eq('id', body.id).select('*').single()
    if (error) throw new Error(error.message)
    return { clawback: data }
  })
}

export async function DELETE(request: Request) {
  return handle(async ({ supabase }) => {
    const body = await readJson(request, z.object({ id }))
    await clawbackOf(supabase, body.id)
    const { error } = await supabase.from('incentive_clawbacks').delete().eq('id', body.id)
    if (error) throw new Error(error.message)
    return { ok: true }
  })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
