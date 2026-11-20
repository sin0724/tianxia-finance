import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Database, IncentiveCarryover, IncentiveLine, IncentiveManager, IncentiveMonth, Json,
} from '@/types/database'
import { fetchSheetGrid } from '@/lib/google-sheets'
import { parseCrmGrid } from './crm'
import { unmappedOwners } from './owners'
import {
  DEFAULT_CONFIG, baseSyncId, planSync, settledMap, summarize, syncShort,
  type CrmRow, type ExistingLine, type IncentiveConfig, type NewLine,
} from './engine'
import type { ContractInfo, CrmView, FinanceEntry, FinanceView, MonthView } from './types'

/**
 * 인센티브 정산 데이터 읽기 · 쓰기. 관리자 세션의 Supabase 클라이언트로만 부른다
 * (표마다 관리자만 통과하는 RLS가 걸려 있다).
 */

export type DB = SupabaseClient<Database>

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const PAGE = 1000

/** Supabase 기본 1,000줄 제한을 넘어도 다 읽는다 */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
}

const must = <T>(res: { data: T; error: { message: string } | null }): T => {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

const pad = (n: number) => String(n).padStart(2, '0')
export const ym = (year: number, month: number) => year * 100 + month
export const prevMonthOf = (year: number, month: number) => (month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 })
export function monthRange(year: number, month: number) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(last)}` }
}

// ── 설정 ─────────────────────────────────────────────────────

export function toConfig(row: Database['public']['Tables']['incentive_settings']['Row'] | null): IncentiveConfig {
  if (!row) return DEFAULT_CONFIG
  const tiers = Array.isArray(row.tiers)
    ? (row.tiers as { min?: unknown; rate?: unknown }[])
        .map((t) => ({ min: Number(t?.min), rate: Number(t?.rate) }))
        .filter((t) => Number.isFinite(t.min) && Number.isFinite(t.rate))
        .sort((a, b) => a.min - b.min)
    : []
  return {
    vatRate: Number(row.vat_rate),
    defaultRate: Number(row.default_rate),
    defaultBase: Number(row.default_base),
    fullStatuses: row.full_statuses.map((s) => s.trim()).filter(Boolean),
    paidRate: Number(row.paid_rate),
    tiers: tiers.length ? tiers : DEFAULT_CONFIG.tiers,
  }
}

export async function loadConfig(db: DB): Promise<IncentiveConfig> {
  return toConfig(must(await db.from('incentive_settings').select('*').eq('id', 1).maybeSingle()))
}

// ── 읽기 ─────────────────────────────────────────────────────

type LiteLine = Pick<IncentiveLine, 'id' | 'manager_id' | 'year' | 'month' | 'position' | 'sync_id' | 'sales' | 'paid' | 'note' | 'client_name'>

async function allLinesLite(db: DB, managerId?: string): Promise<LiteLine[]> {
  return fetchAll<LiteLine>((from, to) => {
    let q = db.from('incentive_lines').select('id, manager_id, year, month, position, sync_id, sales, paid, note, client_name')
    if (managerId) q = q.eq('manager_id', managerId)
    return q.order('id').range(from, to)
  })
}

async function allCarryovers(db: DB, managerId?: string): Promise<IncentiveCarryover[]> {
  return fetchAll<IncentiveCarryover>((from, to) => {
    let q = db.from('incentive_carryovers').select('*')
    if (managerId) q = q.eq('manager_id', managerId)
    return q.order('id').range(from, to)
  })
}

const toExisting = (l: LiteLine): ExistingLine => ({
  id: l.id, year: l.year, month: l.month, position: l.position, sync_id: l.sync_id, sales: l.sales, paid: l.paid, note: l.note,
})

/** 정산시트에서 정산한 마지막 달 — 이월 데이터의 가장 늦은 원래 달 */
async function sheetUntilOf(db: DB): Promise<{ year: number; month: number } | null> {
  const rows = must(await db.from('incentive_carryovers').select('origin_year, origin_month')
    .order('origin_year', { ascending: false }).order('origin_month', { ascending: false }).limit(1))
  const r = rows?.[0]
  return r ? { year: r.origin_year, month: r.origin_month } : null
}

/** 담당자별 가장 최근 달 — 잔금 · 분납 줄은 그 달에만 만든다 */
async function latestMonths(db: DB): Promise<Record<string, { year: number; month: number }>> {
  const rows = must(await db.from('incentive_months').select('manager_id, year, month'))
  const latest: Record<string, { year: number; month: number }> = {}
  for (const r of rows ?? []) {
    const cur = latest[r.manager_id]
    if (!cur || ym(r.year, r.month) > ym(cur.year, cur.month)) latest[r.manager_id] = { year: r.year, month: r.month }
  }
  return latest
}

export async function loadView(db: DB, year: number, month: number): Promise<MonthView> {
  const prev = prevMonthOf(year, month)
  const [settings, managers, months, lines, clawbacks, prevManual, latest, everyLine, carryovers, sheetUntil] = await Promise.all([
    db.from('incentive_settings').select('*').eq('id', 1).maybeSingle(),
    db.from('incentive_managers').select('*').order('sort_order').order('name'),
    db.from('incentive_months').select('*').eq('year', year).eq('month', month),
    db.from('incentive_lines').select('*').eq('year', year).eq('month', month).order('position'),
    db.from('incentive_clawbacks').select('*').eq('year', year).eq('month', month).order('created_at'),
    db.from('incentive_lines').select('*').eq('year', prev.year).eq('month', prev.month).is('sync_id', null).order('position'),
    latestMonths(db),
    allLinesLite(db),
    allCarryovers(db),
    sheetUntilOf(db),
  ])
  const monthLines = must(lines) ?? []
  const managerList = must(managers) ?? []

  // 이 달 줄이 가리키는 계약의 정산 누계 (앱으로 옮기기 전 달 포함)
  const contracts: Record<string, ContractInfo> = {}
  const wanted = new Set(monthLines.filter((l) => l.sync_id).map((l) => `${l.manager_id}|${baseSyncId(l.sync_id!)}`))
  for (const m of managerList) {
    const map = settledMap(
      everyLine.filter((l) => l.manager_id === m.id).map(toExisting),
      carryovers.filter((c) => c.manager_id === m.id),
    )
    for (const [base, e] of map) {
      if (!wanted.has(`${m.id}|${base}`)) continue
      contracts[base] = {
        settled: e.settled, paidCount: e.paidCount,
        originYear: e.origin?.year ?? null, originMonth: e.origin?.month ?? null,
        fromSheet: e.origin?.target === 'carryover',
      }
    }
  }

  // [N월 확인] 메모 — 이 달까지의 모든 줄에서 (지난 달 줄에 "다음 달에 확인"을 적어 두는 경우 포함)
  const tag = `[${month}월 확인]`
  const checks = everyLine
    .filter((l) => l.note.includes(tag) && ym(l.year, l.month) <= ym(year, month))
    .sort((a, b) => ym(a.year, a.month) - ym(b.year, b.month))
    .map((l) => ({ lineId: l.id, managerId: l.manager_id, year: l.year, month: l.month, clientName: l.client_name, note: l.note }))

  return {
    year, month,
    config: toConfig(must(settings)),
    managers: managerList,
    months: must(months) ?? [],
    lines: monthLines,
    clawbacks: must(clawbacks) ?? [],
    prevManual: must(prevManual) ?? [],
    latest,
    contracts,
    checks,
    sheetUntil,
  }
}

type PaymentRow = {
  id: string; amount: number; payment_date: string; manager: string | null; external_id: string | null
  client_name_raw: string | null; memo: string | null; status: 'confirmed' | 'balance_due' | 'unpaid'; excluded: boolean
  projects: unknown
}

/**
 * 재무관리 결제 내역 대조 — 입금은 재무관리 앱이 기준이다.
 *   bySid: 이 달 줄의 계약별 이 달 입금 · 환불 · 이 달 말까지 누계 · 미수
 *   unmatched: 이 달 입금 중 이 달 정산표 줄과 이어지지 않은 것 (이전 계약 잔금 · 분납 · 수동 분납 확인용)
 *   refunds: 이 달 환불
 */
export async function loadFinance(db: DB, view: MonthView): Promise<FinanceView> {
  const { start, end } = monthRange(view.year, view.month)
  const pays = await fetchAll<PaymentRow>((from, to) => db.from('payments')
    .select('id, amount, payment_date, manager, external_id, client_name_raw, memo, status, excluded, projects(name, status)')
    .lte('payment_date', end).order('id').range(from, to) as unknown as PromiseLike<{ data: PaymentRow[] | null; error: { message: string } | null }>)

  const managerOf = (name: string | null) => (name ? view.managers.find((m) => m.crm_names.includes(name.trim())) ?? null : null)
  const lineSids = new Map<string, string>() // base sid → manager_id
  for (const l of view.lines) if (l.sync_id) lineSids.set(baseSyncId(l.sync_id), l.manager_id)

  const bySid: FinanceView['bySid'] = {}
  const unmatched: FinanceView['unmatched'] = []
  const refunds: FinanceView['refunds'] = []
  for (const p of pays) {
    if (p.excluded) continue
    const project = (p.projects as { name?: string; status?: string } | null) ?? null
    const entry: FinanceEntry = {
      id: p.id, date: p.payment_date, amount: Number(p.amount), status: p.status, manager: p.manager,
      client: p.client_name_raw, externalId: p.external_id, projectName: project?.name ?? null,
      projectStatus: project?.status ?? null, memo: p.memo,
    }
    const base = p.external_id ? baseSyncId(p.external_id) : null
    const inMonth = p.payment_date >= start && p.payment_date <= end
    if (base && lineSids.has(base)) {
      const s = (bySid[base] ??= { monthIn: 0, monthRefund: 0, toDate: 0, pending: 0, entries: [] })
      if (p.status === 'confirmed') {
        s.toDate += entry.amount
        if (inMonth) {
          if (entry.amount >= 0) s.monthIn += entry.amount
          else s.monthRefund += entry.amount
          s.entries.push(entry)
        }
      } else {
        s.pending += entry.amount
      }
    }
    if (!inMonth || p.status !== 'confirmed') continue
    const owner = managerOf(p.manager) ?? (base && lineSids.has(base) ? view.managers.find((m) => m.id === lineSids.get(base)) ?? null : null)
    if (!owner) continue // 정산 대상 담당자의 건이 아니다
    if (entry.amount < 0) {
      refunds.push({ ...entry, managerId: owner.id })
      continue
    }
    if (base && lineSids.get(base) === owner.id) continue
    unmatched.push({ ...entry, managerId: owner.id })
  }
  for (const s of Object.values(bySid)) s.entries.sort((a, b) => a.date.localeCompare(b.date))
  unmatched.sort((a, b) => a.date.localeCompare(b.date))
  refunds.sort((a, b) => a.date.localeCompare(b.date))
  return { bySid, unmatched, refunds }
}

/** CRM 결제시트를 읽어 이 달 상황을 보여 준다 — 쓰지 않는다 */
export async function loadCrmView(db: DB, view: MonthView): Promise<CrmView> {
  const crm = parseCrmGrid(await fetchSheetGrid(), view.year)
  const sids = new Set<string>()
  for (const l of view.lines) if (l.sync_id) sids.add(baseSyncId(l.sync_id))
  const bySid: CrmView['bySid'] = {}
  for (const r of crm.rows) {
    if (sids.has(r.sid)) bySid[r.sid] = { name: r.name, owner: r.owner, date: r.date, amount: r.amount, status: r.status, memo: r.memo }
  }

  const preview: CrmView['preview'] = {}
  for (const m of view.managers) {
    const month = view.months.find((x) => x.manager_id === m.id)
    if (!m.active || !month || month.status === 'closed') continue
    const plan = await planFor(db, view.config, m, view.year, view.month, crm.rows, view.latest)
    preview[m.id] = {
      add: plan.add.map((a) => ({ client_name: a.client_name, kind: a.kind, sales: a.sales, paid: a.paid, note: a.note, date: a.crm_date })),
      originUpdates: plan.originUpdates.length,
      latest: plan.stats.latest,
    }
  }
  const aliases = new Set(view.managers.flatMap((m) => m.crm_names))
  const inMonth = (date: string) => date.startsWith(`${view.year}-${pad(view.month)}`)
  const missingSid = crm.missingSid.filter((r) => aliases.has(r.owner) && inMonth(r.date))

  // 시트처럼 담당자명은 글자 그대로 맞춘다. 설정에 없는 값(새 사람 · 새 팀 표기)은 가져오지 않고 확인 목록에 띄운다.
  const unmapped = unmappedOwners([...crm.rows, ...crm.missingSid], view.managers, view.year, view.month)
  return { bySid, preview, missingSid, unmapped }
}

async function planFor(
  db: DB, config: IncentiveConfig, manager: IncentiveManager, year: number, month: number, crm: CrmRow[],
  latest: Record<string, { year: number; month: number }>,
) {
  const [lines, carryovers] = await Promise.all([allLinesLite(db, manager.id), allCarryovers(db, manager.id)])
  const last = latest[manager.id]
  return planSync({
    cfg: config, aliases: manager.crm_names, year, month, crm,
    lines: lines.map(toExisting), carryovers,
    isLatest: !last || ym(year, month) >= ym(last.year, last.month),
  })
}

// ── 쓰기 ─────────────────────────────────────────────────────

export async function getMonth(db: DB, managerId: string, year: number, month: number): Promise<IncentiveMonth | null> {
  return must(await db.from('incentive_months').select('*')
    .eq('manager_id', managerId).eq('year', year).eq('month', month).maybeSingle())
}

/** 마감한 달은 고치지 않는다 */
export async function assertOpen(db: DB, managerId: string, year: number, month: number): Promise<IncentiveMonth> {
  const m = await getMonth(db, managerId, year, month)
  if (!m) throw new HttpError(404, '이 달 정산표가 없습니다.')
  if (m.status === 'closed') throw new HttpError(409, '마감한 달입니다. 마감을 취소한 뒤 고쳐 주세요.')
  return m
}

async function nextPosition(db: DB, managerId: string, year: number, month: number): Promise<number> {
  const rows = must(await db.from('incentive_lines').select('position')
    .eq('manager_id', managerId).eq('year', year).eq('month', month).order('position', { ascending: false }).limit(1))
  return (rows?.[0]?.position ?? 0) + 1
}

/** 새 달 정산표 (Apps Script createMonthSheet_) — I 기본급은 담당자 기본급, 없으면 설정 기본급 */
export async function createMonths(db: DB, year: number, month: number): Promise<string[]> {
  // 정산시트에서 정산한 달을 앱에서 다시 만들면 이월 누계와 겹쳐 잔금 · 분납이 두 번 잡힌다
  const until = await sheetUntilOf(db)
  if (until && ym(year, month) <= ym(until.year, until.month)) {
    throw new HttpError(400, `${until.year}년 ${until.month}월까지는 정산시트에서 정산했습니다. 앱 정산표는 그다음 달부터 만듭니다.`)
  }
  const [config, managers, existing] = await Promise.all([
    loadConfig(db),
    db.from('incentive_managers').select('*').eq('active', true).order('sort_order').order('name'),
    db.from('incentive_months').select('manager_id').eq('year', year).eq('month', month),
  ])
  const have = new Set((must(existing) ?? []).map((r) => r.manager_id))
  const todo = (must(managers) ?? []).filter((m) => !have.has(m.id))
  if (todo.length) {
    must(await db.from('incentive_months').insert(todo.map((m) => ({
      manager_id: m.id, year, month, base_salary: m.base_salary ?? config.defaultBase,
    }))).select('id'))
  }
  return todo.map((m) => m.name)
}

/**
 * CRM 동기화 (Apps Script "특정 월 전체 동기화") — 정산표가 있고 마감하지 않은 담당자만.
 * 새 줄은 맨 아래에 붙이고, 잔금 · 분납으로 바뀐 원래 줄은 비고 · 색만 고친다.
 */
export async function syncMonth(db: DB, year: number, month: number): Promise<string[]> {
  const [config, managersRes, monthsRes, latest] = await Promise.all([
    loadConfig(db),
    db.from('incentive_managers').select('*').eq('active', true).order('sort_order').order('name'),
    db.from('incentive_months').select('*').eq('year', year).eq('month', month),
    latestMonths(db),
  ])
  const crm = parseCrmGrid(await fetchSheetGrid(), year)
  const months = must(monthsRes) ?? []
  const out: string[] = []
  for (const m of must(managersRes) ?? []) {
    const sheet = months.find((x) => x.manager_id === m.id)
    if (!sheet) { out.push(`${m.name} ${month}월 : 정산표 없음 (건너뜀)`); continue }
    if (sheet.status === 'closed') { out.push(`${m.name} ${month}월 : 마감한 달 (건너뜀)`); continue }
    const plan = await planFor(db, config, m, year, month, crm.rows, latest)
    if (plan.add.length) {
      const start = await nextPosition(db, m.id, year, month)
      must(await db.from('incentive_lines').insert(plan.add.map((l: NewLine, i) => ({
        manager_id: m.id, year, month, position: start + i,
        client_name: l.client_name, sales: l.sales, paid: l.paid, rate: null, note: l.note,
        sync_id: l.sync_id, crm_date: l.crm_date, kind: l.kind, fill: l.fill,
      }))).select('id'))
    }
    for (const u of plan.originUpdates) {
      if (u.target === 'line') {
        must(await db.from('incentive_lines').update(u.note === undefined ? { fill: u.fill } : { fill: u.fill, note: u.note }).eq('id', u.id).select('id'))
      } else {
        must(await db.from('incentive_carryovers').update(u.note === undefined ? { origin_fill: u.fill } : { origin_fill: u.fill, origin_note: u.note }).eq('id', u.id).select('id'))
      }
    }
    out.push(`${m.name} ${month}월 : ${syncShort(plan.stats)}`)
  }
  return out
}

/**
 * 설정에 없는 CRM 담당자 값을 기존 담당자의 CRM 담당자명에 붙이거나 새 담당자로 만든다.
 * 그다음 이 달 정산표가 없는 담당자 것을 만들고 (정산시트에서 정산한 달은 빼고) CRM 동기화를 한다.
 */
export async function assignOwner(
  db: DB, args: { year: number; month: number; owner: string; managerId?: string; newName?: string },
): Promise<{ manager: string; created: string[]; messages: string[]; syncError: string | null }> {
  const owner = args.owner.trim()
  const managers = must(await db.from('incentive_managers').select('*').order('sort_order').order('name')) ?? []
  const holder = managers.find((m) => m.crm_names.includes(owner))
  if (holder) {
    throw new HttpError(409, holder.active
      ? `‘${owner}’는 이미 ${holder.name}의 CRM 담당자명입니다.`
      : `‘${owner}’는 쉬는 담당자 ${holder.name}의 CRM 담당자명입니다. 설정에서 ${holder.name}의 ‘사용’을 켜 주세요.`)
  }

  let saved: IncentiveManager | null
  if (args.managerId) {
    const m = managers.find((x) => x.id === args.managerId)
    if (!m) throw new HttpError(404, '담당자를 찾을 수 없습니다.')
    if (!m.active) throw new HttpError(409, `${m.name}은(는) 쉬는 담당자입니다. 설정에서 ‘사용’을 켠 뒤 연결해 주세요.`)
    saved = must(await db.from('incentive_managers').update({ crm_names: [...m.crm_names, owner] }).eq('id', m.id).select('*').single())
  } else {
    const name = (args.newName ?? '').trim()
    if (!name) throw new HttpError(400, '새 담당자 이름을 적어 주세요.')
    if (managers.some((m) => m.name === name)) throw new HttpError(409, `같은 이름의 담당자가 있습니다: ${name}. 그 담당자에 연결해 주세요.`)
    const sort = managers.reduce((mx, m) => Math.max(mx, m.sort_order), 0) + 1
    saved = must(await db.from('incentive_managers')
      .insert({ name, crm_names: [owner], base_salary: null, sort_order: sort, active: true }).select('*').single())
  }
  if (!saved) throw new Error('담당자를 저장하지 못했습니다.')

  let created: string[] = []
  try {
    created = await createMonths(db, args.year, args.month)
  } catch (e) {
    // 정산시트에서 정산한 달이면 정산표는 만들지 않고 연결만 한다
    if (!(e instanceof HttpError && e.status === 400)) throw e
  }
  try {
    return { manager: saved.name, created, messages: await syncMonth(db, args.year, args.month), syncError: null }
  } catch (e) {
    return { manager: saved.name, created, messages: [], syncError: e instanceof Error ? e.message : String(e) }
  }
}

/** 마감 — 그때의 H~O를 남겨 둔다. E가 오류인 줄이 있으면 마감하지 않는다 */
export async function closeMonth(db: DB, monthId: string): Promise<IncentiveMonth> {
  const m = must(await db.from('incentive_months').select('*').eq('id', monthId).maybeSingle())
  if (!m) throw new HttpError(404, '이 달 정산표가 없습니다.')
  const [config, lines, claws] = await Promise.all([
    loadConfig(db),
    db.from('incentive_lines').select('*').eq('manager_id', m.manager_id).eq('year', m.year).eq('month', m.month),
    db.from('incentive_clawbacks').select('*').eq('manager_id', m.manager_id).eq('year', m.year).eq('month', m.month),
  ])
  const s = summarize(must(lines) ?? [], m, must(claws) ?? [], config)
  if (s.errors) throw new HttpError(400, `인센티브율을 읽을 수 없는 줄이 ${s.errors}개 있습니다. F칸을 고친 뒤 마감해 주세요.`)
  const snapshot = { ...s, lines: (must(lines) ?? []).length, closedAt: new Date().toISOString() } as unknown as Json
  const closed = must(await db.from('incentive_months').update({ status: 'closed', closed_at: new Date().toISOString(), snapshot })
    .eq('id', monthId).select('*').single())
  if (!closed) throw new Error('마감을 저장하지 못했습니다.')
  return closed
}

/** 지난달 수동 줄(동기화ID 없음)을 이 달로 — 분납 수동 건처럼 B는 0으로 두고 입금 확인 후 채운다 */
export async function copyManualLines(db: DB, ids: string[], target: { managerId: string; year: number; month: number }) {
  const src = must(await db.from('incentive_lines').select('*').in('id', ids)) ?? []
  const rows = src.filter((l) => !l.sync_id && l.manager_id === target.managerId)
  if (!rows.length) return 0
  const start = await nextPosition(db, target.managerId, target.year, target.month)
  must(await db.from('incentive_lines').insert(rows.sort((a, b) => a.position - b.position).map((l, i) => ({
    manager_id: target.managerId, year: target.year, month: target.month, position: start + i,
    client_name: l.client_name, sales: 0, paid: null, rate: l.rate, note: l.note, kind: 'manual' as const, fill: 'yellow' as const,
  }))).select('id'))
  return rows.length
}

export { nextPosition }
