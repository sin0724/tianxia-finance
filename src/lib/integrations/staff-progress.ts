import { timingSafeEqual } from 'node:crypto'
import { kstToday } from '../kst'

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
  'contracted',
  'delivered',
  'remaining',
] as const

export const STAFF_ITEM_COLUMNS = [
  'project_item_id',
  'category',
  'product_name',
  'contracted',
  'delivered',
  'remaining',
] as const

export const DELIVERY_COLUMNS = [
  'id',
  'project_item_id',
  'quantity',
  'delivered_at',
  'note',
  'source',
  'external_key',
  'created_at',
] as const

export const EMPLOYEE_COLUMNS = ['id', 'name'] as const

export const STAFF_PROGRESS_SELECT = STAFF_PROGRESS_COLUMNS.join(',')
export const DELIVERY_SELECT = DELIVERY_COLUMNS.join(',')
export const EMPLOYEE_SELECT = EMPLOYEE_COLUMNS.join(',')

/** 납품 대상 항목을 찾을 때 읽는 열. 금액 열은 없다. */
export const ITEM_LOOKUP_SELECT = 'id,product_id'
/** 카테고리 매칭용. 상품명·가격·원가는 읽지 않는다. */
export const PRODUCT_CATEGORY_SELECT = 'id,category'

export const PROJECT_STATUSES = ['ongoing', 'completed', 'cancelled'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type StaffProgressItem = {
  project_item_id: string
  category: string | null
  product_name: string | null
  contracted: number
  delivered: number
  remaining: number
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
  contracted: number
  delivered: number
  remaining: number
}

export type DeliveryResponse = {
  id: string
  project_item_id: string
  quantity: number
  delivered_at: string
  note: string | null
  source: string
  external_key: string | null
  created_at: string
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

export type DeliveryInput = {
  projectItemId: string | null
  projectId: string | null
  category: string | null
  quantity: number
  deliveredAt: string | null
  note: string | null
  externalKey: string | null
}

export function parseDeliveryBody(body: unknown):
  | { ok: true; value: DeliveryInput }
  | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'invalid_body' }

  const projectItemId = optionalUuid(body.project_item_id)
  if (projectItemId === 'invalid') return { ok: false, error: 'invalid_project_item_id' }
  const projectId = optionalUuid(body.project_id)
  if (projectId === 'invalid') return { ok: false, error: 'invalid_project_id' }

  const category = optionalText(body.category, 200)
  if (category === 'invalid') return { ok: false, error: 'invalid_category' }

  if (!projectItemId && !(projectId && category)) {
    return { ok: false, error: 'missing_target' }
  }

  if (typeof body.quantity !== 'number' || !Number.isInteger(body.quantity) || body.quantity <= 0 || body.quantity > 2147483647) {
    return { ok: false, error: 'invalid_quantity' }
  }

  const deliveredAt = optionalDate(body.delivered_at)
  if (deliveredAt === 'invalid') return { ok: false, error: 'invalid_delivered_at' }

  const note = optionalText(body.note, 2000)
  if (note === 'invalid') return { ok: false, error: 'invalid_note' }

  const externalKey = optionalText(body.external_key, 200)
  if (externalKey === 'invalid') return { ok: false, error: 'invalid_external_key' }

  return {
    ok: true,
    value: {
      projectItemId,
      projectId: projectItemId ? null : projectId,
      category: projectItemId ? null : category,
      quantity: body.quantity,
      deliveredAt,
      note,
      externalKey,
    },
  }
}

export function matchItemIdsByCategory(
  items: { id: string; category: string | null }[],
  category: string,
): string[] {
  const needle = category.trim()
  if (!needle) return []
  return items
    .filter((item) => (item.category ?? '').trim() === needle)
    .map((item) => item.id)
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
    contracted: asInt(record.contracted),
    delivered: asInt(record.delivered),
    remaining: asInt(record.remaining),
  }
}

export function shapeStaffItem(row: unknown): StaffProgressItem {
  const record = asRecord(row)
  return {
    project_item_id: asString(record.project_item_id),
    category: asStringOrNull(record.category),
    product_name: asStringOrNull(record.product_name),
    contracted: asInt(record.contracted),
    delivered: asInt(record.delivered),
    remaining: asInt(record.remaining),
  }
}

export function shapeDelivery(row: unknown): DeliveryResponse {
  const record = asRecord(row)
  return {
    id: asString(record.id),
    project_item_id: asString(record.project_item_id),
    quantity: asInt(record.quantity),
    delivered_at: asString(record.delivered_at),
    note: asStringOrNull(record.note),
    source: asString(record.source),
    external_key: asStringOrNull(record.external_key),
    created_at: asString(record.created_at),
  }
}

export function shapeEmployee(row: unknown): EmployeeResponse | null {
  const record = asRecord(row)
  const id = asStringOrNull(record.id)
  if (!id) return null
  return { id, name: asString(record.name) }
}

export function deliveryDateOrToday(deliveredAt: string | null, now = new Date()): string {
  return deliveredAt ?? kstToday(now)
}

function optionalUuid(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !UUID_RE.test(value)) return 'invalid'
  return value
}

function optionalText(value: unknown, max: number): string | null | 'invalid' {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return 'invalid'
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > max) return 'invalid'
  return trimmed
}

function optionalDate(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !isIsoDate(value)) return 'invalid'
  return value
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
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
