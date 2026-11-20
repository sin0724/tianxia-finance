/**
 * 인센티브 정산 — 설정 탭 (기본값 · 담당자 매핑 · 환수 인정률 구간). 관리자만 (아니면 404).
 * 담당자는 지우지 않고 쉬게(active=false) 한다 — 지난 달 정산표가 담당자를 가리키고 있다.
 *
 *   PATCH /api/incentives/setup  { settings?, managers? }
 */
import { z } from 'zod'
import { handle, id, readJson, won } from '@/lib/incentives/api'

const rate = z.number().min(0).max(1)
const schema = z.object({
  settings: z.object({
    vat_rate: rate,
    default_rate: rate,
    default_base: won.min(0),
    full_statuses: z.array(z.string().trim().min(1)).min(1).max(10),
    paid_rate: rate,
    tiers: z.array(z.object({ min: z.number().min(0).max(100), rate: z.number().min(0).max(100) })).min(1).max(20),
  }).optional(),
  managers: z.array(z.object({
    id: id.optional(),
    name: z.string().trim().min(1).max(50),
    crm_names: z.array(z.string().trim().min(1).max(50)).min(1).max(10),
    base_salary: won.min(0).nullable(),
    sort_order: z.number().int().min(0).max(1000),
    active: z.boolean(),
  })).max(50).optional(),
})

export async function PATCH(request: Request) {
  return handle(async ({ supabase }) => {
    const body = await readJson(request, schema)
    if (body.settings) {
      const tiers = [...body.settings.tiers].sort((a, b) => a.min - b.min)
      const { error } = await supabase.from('incentive_settings').upsert({ id: 1, ...body.settings, tiers })
      if (error) throw new Error(error.message)
    }
    for (const m of body.managers ?? []) {
      const row = { name: m.name, crm_names: m.crm_names, base_salary: m.base_salary, sort_order: m.sort_order, active: m.active }
      const { error } = m.id
        ? await supabase.from('incentive_managers').update(row).eq('id', m.id)
        : await supabase.from('incentive_managers').insert(row)
      if (error) throw new Error(error.message.includes('duplicate') ? `같은 이름의 담당자가 있습니다: ${m.name}` : error.message)
    }
    return { ok: true }
  })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
