import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  EMPLOYEE_COLUMNS,
  EMPLOYEE_SELECT,
  STAFF_ITEM_COLUMNS,
  STAFF_PROGRESS_COLUMNS,
  STAFF_PROGRESS_SELECT,
  TOTALS_COLUMNS,
  isStaffProgressAuthorized,
  parseStaffProgressFilters,
  shapeEmployee,
  shapeStaffProgress,
} from './staff-progress'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')

const FORBIDDEN_KEYS = [
  'unit_cost_snapshot',
  'unit_price_snapshot',
  'current_cost',
  'price_vat_incl',
  'base_salary',
  'hourly_wage',
  'incentive_value',
  'incentive_type',
  'gross_profit',
  'operating_profit',
  'total_product_cost',
  'margin',
  'payroll',
  'settlement',
  'delivered',
  'remaining',
  'project_item_id',
  'delivered_at',
  'external_key',
]

function collectKeys(value: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc)
    return acc
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      acc.add(key)
      collectKeys(child, acc)
    }
  }
  return acc
}

test('진행 피드 응답 키는 허용 목록과 같고 납품·원가 키를 버린다', () => {
  const shaped = shapeStaffProgress({
    project_id: 'p1',
    client_id: 'c1',
    client_name: '클라이언트',
    project_name: '캠페인',
    status: 'ongoing',
    contract_date: '2026-10-01',
    assignee_employee_id: 'e1',
    assignee_name: '김하늘',
    contract_amount: '1500000.50',
    paid_amount: '500000',
    base_salary: 9_000_000,
    current_cost: 10,
    hourly_wage: 12000,
    unit_cost_snapshot: 100,
    margin: 40,
    delivered: 1,
    remaining: 2,
    memo: '내부 메모',
    items: JSON.stringify([
      {
        project_item_id: 'i1',
        category: 'Dcard',
        product_name: '디카드',
        contracted: '3',
        delivered: 1,
        remaining: 2,
        unit_cost_snapshot: 100,
        unit_price_snapshot: 200,
      },
    ]),
    totals: { contracted: '3', delivered: 1, remaining: 2, base_salary: 1 },
  })

  assert.deepEqual(Object.keys(shaped), [...STAFF_PROGRESS_COLUMNS])
  assert.deepEqual(Object.keys(shaped.items[0]), [...STAFF_ITEM_COLUMNS])
  assert.deepEqual(Object.keys(shaped.totals), [...TOTALS_COLUMNS])
  assert.equal(shaped.contract_amount, 1500000.5)
  assert.equal(shaped.paid_amount, 500000)
  assert.equal(shaped.items[0].contracted, 3)
  assert.equal(shaped.items[0].category, 'Dcard')
  assert.equal(shaped.totals.contracted, 3)

  const keys = collectKeys(shaped)
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.has(forbidden), false, forbidden)
  }
})

test('직원 응답은 id 와 이름만 남긴다', () => {
  const employee = shapeEmployee({
    id: 'e1',
    name: '김하늘',
    base_salary: 4000000,
    hourly_wage: 12000,
    incentive_value: 10,
    active: true,
  })
  assert.deepEqual(employee, { id: 'e1', name: '김하늘' })
  assert.deepEqual(Object.keys(employee ?? {}), [...EMPLOYEE_COLUMNS])
  assert.equal(shapeEmployee({ name: '이름없음', base_salary: 1 }), null)
})

test('select 문자열은 허용 컬럼과 같고 금지 컬럼을 포함하지 않는다', () => {
  assert.equal(STAFF_PROGRESS_SELECT, STAFF_PROGRESS_COLUMNS.join(','))
  assert.equal(EMPLOYEE_SELECT, EMPLOYEE_COLUMNS.join(','))

  const selects = [STAFF_PROGRESS_SELECT, EMPLOYEE_SELECT]
  for (const forbidden of FORBIDDEN_KEYS) {
    for (const select of selects) {
      assert.equal(select.split(',').includes(forbidden), false, `${select} contains ${forbidden}`)
    }
  }
})

test('연동 라우트는 진행 피드와 직원만 있고 금지 컬럼을 읽지 않는다', () => {
  const files = [
    'src/app/api/integrations/staff-progress/route.ts',
    'src/app/api/integrations/employees/route.ts',
  ].map((file) => readFileSync(join(root, file), 'utf8'))

  const combined = files.join('\n')
  assert.match(files[0], /STAFF_PROGRESS_SELECT/)
  assert.match(files[0], /shapeStaffProgress/)
  assert.match(files[1], /EMPLOYEE_SELECT/)
  assert.match(files[1], /shapeEmployee/)
  assert.equal(combined.includes('project_deliveries'), false)
  assert.doesNotMatch(combined, /\.select\(\s*['"`]\*/)

  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(combined.includes(forbidden), false, forbidden)
  }
})

test('뷰는 계약 수량만 모으고 납품 테이블을 만들지 않는다', () => {
  const sql = readFileSync(join(root, 'supabase/migrations/025_staff_project_progress.sql'), 'utf8')
  const view = sql.slice(sql.indexOf('CREATE OR REPLACE VIEW staff_project_progress'))
  assert.match(view, /security_invoker = true/)
  assert.match(sql, /assignee_employee_id uuid/)
  assert.match(view, /e\.name AS assignee_name/)
  assert.match(view, /jsonb_build_object\('contracted', COALESCE\(agg\.contracted, 0\)\) AS totals/)
  assert.equal(sql.includes('project_deliveries'), false)
  for (const column of ['project_id', 'client_id', 'client_name', 'project_name', 'status', 'contract_date', 'assignee_employee_id', 'assignee_name', 'contract_amount', 'paid_amount', 'items', 'totals']) {
    assert.match(view, new RegExp(`\\b${column}\\b`))
  }
  for (const forbidden of [...FORBIDDEN_KEYS, 'project_deliveries']) {
    assert.equal(view.includes(forbidden), false, forbidden)
  }
})

test('시크릿이 없거나 다르면 거절하고, 같은 Bearer 만 허용한다', () => {
  const previous = process.env.STAFF_PROGRESS_SECRET
  try {
    process.env.STAFF_PROGRESS_SECRET = 'staff-secret'
    assert.equal(
      isStaffProgressAuthorized(new Request('http://localhost/api', {
        headers: { authorization: 'Bearer staff-secret' },
      })),
      true,
    )
    assert.equal(isStaffProgressAuthorized(new Request('http://localhost/api')), false)
    assert.equal(
      isStaffProgressAuthorized(new Request('http://localhost/api', {
        headers: { authorization: 'Bearer wrong' },
      })),
      false,
    )
    delete process.env.STAFF_PROGRESS_SECRET
    assert.equal(
      isStaffProgressAuthorized(new Request('http://localhost/api', {
        headers: { authorization: 'Bearer staff-secret' },
      })),
      false,
    )
  } finally {
    if (previous === undefined) delete process.env.STAFF_PROGRESS_SECRET
    else process.env.STAFF_PROGRESS_SECRET = previous
  }
})

test('진행 피드 필터는 상태와 담당자 UUID/이름을 구분한다', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  assert.deepEqual(
    parseStaffProgressFilters(new URLSearchParams(`status=ongoing&assignee=${id}`)),
    { ok: true, status: 'ongoing', assigneeId: id, assigneeName: null },
  )
  assert.deepEqual(
    parseStaffProgressFilters(new URLSearchParams('assignee=김하늘')),
    { ok: true, status: null, assigneeId: null, assigneeName: '김하늘' },
  )
  assert.deepEqual(parseStaffProgressFilters(new URLSearchParams('status=paused')), {
    ok: false, error: 'invalid_status',
  })
})
