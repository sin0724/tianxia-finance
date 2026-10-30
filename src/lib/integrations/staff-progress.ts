import { timingSafeEqual } from 'node:crypto'

/**
 * 직원 CRM 연동 응답에 허용하는 키.
 * 라우트는 이 목록으로만 select 하고, 직렬화 시에도 같은 목록만 남긴다.
 */

export const STAFF_PROGRESS_COLUMNS = [
  'project_id',
  'client_id',
  'client_name',
  'project_name',
  'status',
  'contract_date',
  'assignee_employee_id',
  'assignee_name',
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

export const EMPLOYEE_COLUMNS = ['id', 'name'] as const

export const STAFF_PROGRESS_SELECT = STAFF_PROGRESS_COLUMNS.join(',')
export const EMPLOYEE_SELECT = EMPLOYEE_COLUMNS.join(',')

export const PROJECT_STATUSES = ['ongoing', 'completed', 'cancelled'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type StaffProgressItem = {
  category: string | null
  product_name: string | null
  contracted: number
}

export type StaffProgressTotals = {
  contracted: number
}

export type StaffProgress = {
  project_id: string
  client_id: string | null
  client_name: string | null
  project_name: string
  status: string
  contract_date: string | null
  assignee_employee_id: string | null
  assignee_name: string | null
  contract_amount: number
  paid_amount: number
  items: StaffProgressItem[]
  totals: StaffProgressTotals
}

export type EmployeeResponse = {
  id: string
  name: string
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
  | { ok: true; status: ProjectStatus | null; assigneeId: string | null; assigneeName: string | null }
  | { ok: false; error: string } {
  const rawStatus = (params.get('status') ?? '').trim()
  let status: ProjectStatus | null = null
  if (rawStatus) {
    if (!PROJECT_STATUSES.includes(rawStatus as ProjectStatus)) {
      return { ok: false, error: 'invalid_status' }
    }
    status = rawStatus as ProjectStatus
  }

  const assignee = (params.get('assignee') ?? '').trim()
  if (!assignee) {
    return { ok: true, status, assigneeId: null, assigneeName: null }
  }
  if (UUID_RE.test(assignee)) {
    return { ok: true, status, assigneeId: assignee, assigneeName: null }
  }
  if (assignee.length > 200) return { ok: false, error: 'invalid_assignee' }
  return { ok: true, status, assigneeId: null, assigneeName: assignee }
}

export function shapeStaffProgress(row: unknown): StaffProgress {
  const record = asRecord(row)
  return {
    project_id: asString(record.project_id),
    client_id: asStringOrNull(record.client_id),
    client_name: asStringOrNull(record.client_name),
    project_name: asString(record.project_name),
    status: asString(record.status),
    contract_date: asStringOrNull(record.contract_date),
    assignee_employee_id: asStringOrNull(record.assignee_employee_id),
    assignee_name: asStringOrNull(record.assignee_name),
    contract_amount: asNumber(record.contract_amount),
    paid_amount: asNumber(record.paid_amount),
    items: asArray(record.items).map(shapeStaffItem),
    totals: shapeTotals(record.totals),
  }
}

export function shapeStaffItem(row: unknown): StaffProgressItem {
  const record = asRecord(row)
  return {
    category: asStringOrNull(record.category),
    product_name: asStringOrNull(record.product_name),
    contracted: asInt(record.contracted),
  }
}

export function shapeTotals(value: unknown): StaffProgressTotals {
  const record = asRecord(value)
  return { contracted: asInt(record.contracted) }
}

export function shapeEmployee(row: unknown): EmployeeResponse | null {
  const record = asRecord(row)
  const id = asStringOrNull(record.id)
  if (!id) return null
  return { id, name: asString(record.name) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
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
