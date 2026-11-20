/**
 * 인센티브 정산 — 설정 탭 (기본값 · 담당자 매핑 · 환수 인정률 구간). 관리자만 (아니면 404).
 * 담당자는 지우지 않고 쉬게(active=false) 한다 — 지난 달 정산표가 담당자를 가리키고 있다.
 * CRM 담당자명은 한 담당자에만 둔다 — 두 담당자에 있으면 같은 CRM 줄이 두 번 정산된다.
 * Slack 결제 담당자(Slack /결제 담당자 목록에 보일 이름)는 CRM 담당자명에도 넣는다 — /결제로 등록한 줄이 그 담당자 정산에 들어간다.
 * 담당자 기본율은 새로 만드는 달부터 들어간다 (이미 만든 달은 정산표 위에서 고친다).
 *
 *   PATCH /api/incentives/setup  { settings?, managers? }
 */
import { z } from 'zod'
import { handle, id, readJson, won } from '@/lib/incentives/api'
import { duplicateCrmNames } from '@/lib/incentives/owners'
import { HttpError } from '@/lib/incentives/server'

const rate = z.number().min(0).max(1)
const crmName = z.string().trim().min(1).max(50)
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
    crm_names: z.array(crmName).max(20),
    slack_names: z.array(crmName).max(10).optional(),
    base_salary: won.min(0).nullable(),
    /** 담당자 기본 인센티브율 (0.05 = 5%). null 이면 설정의 기본 인센티브율 */
    default_rate: rate.nullable().optional(),
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
    if (!body.managers?.length) return { ok: true }

    const rows = body.managers.map((m) => {
      const slackNames = m.slack_names === undefined ? undefined : [...new Set(m.slack_names)]
      const crmNames = [...new Set([...m.crm_names, ...(slackNames ?? [])])]
      if (!crmNames.length) throw new HttpError(400, `${m.name}: CRM 담당자명이나 Slack 결제 담당자를 적어 주세요.`)
      return {
        id: m.id, slackNames, defaultRate: m.default_rate,
        row: { name: m.name, crm_names: crmNames, base_salary: m.base_salary, sort_order: m.sort_order, active: m.active },
      }
    })

    const { data: current, error } = await supabase.from('incentive_managers').select('*')
    if (error) throw new Error(error.message)
    const next = new Map((current ?? []).map((m) => [m.id, { name: m.name, crm_names: m.crm_names }]))
    rows.forEach((r, i) => next.set(r.id ?? `new-${i}`, { name: r.row.name, crm_names: r.row.crm_names }))
    const dup = duplicateCrmNames([...next.values()])
    if (dup.length) {
      throw new HttpError(400, `CRM 담당자명은 한 담당자에만 둡니다: ${dup.map((d) => `‘${d.crmName}’ (${d.managers.join(', ')})`).join(' · ')}`)
    }

    // 028 · 029 마이그레이션 전에는 slack_names · default_rate 칸이 없다 — 비어 있으면 빼고 저장한다.
    // 보내지 않은 칸(예전 화면)은 그대로 둔다.
    const cols = new Set((current ?? []).flatMap((m) => Object.keys(m)))
    for (const r of rows) {
      const row: typeof r.row & { slack_names?: string[]; default_rate?: number | null } = { ...r.row }
      if (r.slackNames !== undefined && (cols.has('slack_names') || r.slackNames.length)) row.slack_names = r.slackNames
      if (r.defaultRate !== undefined && (cols.has('default_rate') || r.defaultRate !== null)) row.default_rate = r.defaultRate
      const { error: e } = r.id
        ? await supabase.from('incentive_managers').update(row).eq('id', r.id)
        : await supabase.from('incentive_managers').insert(row)
      if (e) {
        if (e.message.includes('slack_names')) throw new HttpError(409, 'Slack 결제 담당자를 저장하려면 028 마이그레이션을 먼저 실행해 주세요.')
        if (e.message.includes('default_rate')) throw new HttpError(409, '담당자 기본율을 저장하려면 029 마이그레이션을 먼저 실행해 주세요.')
        throw new Error(e.message.includes('duplicate') ? `같은 이름의 담당자가 있습니다: ${r.row.name}` : e.message)
      }
    }
    return { ok: true }
  })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
