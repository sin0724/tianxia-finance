import { timingSafeEqual } from 'node:crypto'

/**
 * 직원 CRM 연동 응답에 허용하는 키.
 * 조회 select 와 직렬화 결과가 이 목록을 넘지 않는다.
 * 담당자는 재무에 두지 않는다. CRM 이 고객명으로 맞춘다.
 */

export const STAFF_PROGRESS_COLUMNS = [
  'client',
  'project',
  'status',
  'contract_date',
  'contract_amount',
  'paid_amount',
  'items',
  'totals',
] as const

export const STAFF_ITEM_COLUMNS = [
  'category',
  'product_name',
  'contracted',
] as const

export const TOTALS_COLUMNS = ['contracted'] as const

/** 진행 피드가 읽는 열. 금액·급여 열은 없다. */
export const PROJECT_SELECT = 'id,client_id,name,status,contract_date,total_amount'
export const CLIENT_SELECT = 'id,name'
export const PAYMENT_SELECT = 'project_id,amount'
export const ITEM_SELECT = 'project_id,product_id,quantity,created_at'
export const PRODUCT_SELECT = 'id,category,name'

export const PROJECT_STATUSES = ['ongoing', 'completed', 'cancelled'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export type StaffProgressItem = {
  category: string | null
  product_name: string | null
  contracted: number
}

export type StaffProgressTotals = {
  contracted: number
}

export type StaffProgress = {
  client: string | null
  project: string
  status: string
  contract_date: string | null
  contract_amount: number
  paid_amount: number
  items: StaffProgressItem[]
  totals: StaffProgressTotals
}

export function integrationJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

export function isStaffProgressAuthorized(request: Request): boolean {
  const secret = process.env.STAFF_PROGRESS_SECRET
  if (!secret) return false
  const header = request.headers.get('authorization')
  if (!header) return false
  const expected = `Bearer ${secret}`
  const actual = Buffer.from(header)
  const wanted = Buffer.from(expected)
  if (actual.length !== wanted.length) return false
  return timingSafeEqual(actual, wanted)
}

export function parseStaffProgressFilters(params: URLSearchParams):
  | { ok: true; status: ProjectStatus | null }
  | { ok: false; error: string } {
  const rawStatus = (params.get('status') ?? '').trim()
  if (!rawStatus) return { ok: true, status: null }
  if (!PROJECT_STATUSES.includes(rawStatus as ProjectStatus)) {
    return { ok: false, error: 'invalid_status' }
  }
  return { ok: true, status: rawStatus as ProjectStatus }
}

export function buildStaffProgress(input: {
  projects: unknown[]
  clients: unknown[]
  payments: unknown[]
  items: unknown[]
  products: unknown[]
}): StaffProgress[] {
  const clientNames = new Map<string, string>()
  for (const row of input.clients) {
    const record = asRecord(row)
    const id = asStringOrNull(record.id)
    if (!id) continue
    clientNames.set(id, asString(record.name))
  }

  const productById = new Map<string, { category: string | null; name: string }>()
  for (const row of input.products) {
    const record = asRecord(row)
    const id = asStringOrNull(record.id)
    if (!id) continue
    productById.set(id, {
      category: asStringOrNull(record.category),
      name: asString(record.name),
    })
  }

  const paidByProject = new Map<string, number>()
  for (const row of input.payments) {
    const record = asRecord(row)
    const projectId = asStringOrNull(record.project_id)
    if (!projectId) continue
    paidByProject.set(projectId, (paidByProject.get(projectId) ?? 0) + asNumber(record.amount))
  }

  const itemsByProject = new Map<string, { createdAt: string; item: StaffProgressItem }[]>()
  for (const row of input.items) {
    const record = asRecord(row)
    const projectId = asStringOrNull(record.project_id)
    if (!projectId) continue
    const productId = asStringOrNull(record.product_id)
    const product = productId ? productById.get(productId) : undefined
    const bucket = itemsByProject.get(projectId) ?? []
    bucket.push({
      createdAt: asString(record.created_at),
      item: {
        category: product?.category ?? null,
        product_name: product?.name ?? null,
        contracted: asInt(record.quantity),
      },
    })
    itemsByProject.set(projectId, bucket)
  }

  const projects: { sortDate: string; project: StaffProgress }[] = []
  for (const row of input.projects) {
    const record = asRecord(row)
    const id = asStringOrNull(record.id)
    if (!id) continue
    const clientId = asStringOrNull(record.client_id)
    const itemRows = (itemsByProject.get(id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const items = itemRows.map((entry) => entry.item)
    const contracted = items.reduce((sum, item) => sum + item.contracted, 0)
    projects.push({
      sortDate: asString(record.contract_date),
      project: {
        client: clientId ? (clientNames.get(clientId) ?? null) : null,
        project: asString(record.name),
        status: asString(record.status),
        contract_date: asStringOrNull(record.contract_date),
        contract_amount: asNumber(record.total_amount),
        paid_amount: paidByProject.get(id) ?? 0,
        items,
        totals: { contracted },
      },
    })
  }

  projects.sort((a, b) => {
    if (a.sortDate === '' && b.sortDate !== '') return 1
    if (b.sortDate === '' && a.sortDate !== '') return -1
    if (a.sortDate !== b.sortDate) return b.sortDate.localeCompare(a.sortDate)
    return a.project.project.localeCompare(b.project.project, 'ko')
  })

  return projects.map((entry) => entry.project)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function asInt(value: unknown): number {
  return Math.trunc(asNumber(value))
}
