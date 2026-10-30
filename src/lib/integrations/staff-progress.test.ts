import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CLIENT_SELECT,
  ITEM_SELECT,
  PAYMENT_SELECT,
  PRODUCT_SELECT,
  PROJECT_SELECT,
  STAFF_ITEM_COLUMNS,
  STAFF_PAYMENT_COLUMNS,
  STAFF_PROGRESS_COLUMNS,
  TOTALS_COLUMNS,
  buildStaffProgress,
  isStaffProgressAuthorized,
  parseStaffProgressFilters,
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
  'assignee_employee_id',
  'assignee_name',
  'assignee',
  'manager',
  'memo',
  'source',
  'external_id',
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

test('진행 피드는 고객명·프로젝트·계약 수량만 반환하고 담당·원가 키를 버린다', () => {
  const rows = buildStaffProgress({
    projects: [
      {
        id: 'p1',
        client_id: 'c1',
        name: '캠페인',
        status: 'ongoing',
        contract_date: '2026-10-01',
        total_amount: '1500000.50',
        memo: '내부',
        assignee_employee_id: 'e1',
        base_salary: 1,
      },
      {
        id: 'p2',
        client_id: null,
        name: '이름만',
        status: 'completed',
        contract_date: null,
        total_amount: 10,
      },
    ],
    clients: [{ id: 'c1', name: '클라이언트', contact: '010', manager: '숨김' }],
    payments: [
      {
        id: 'pay-late',
        project_id: 'p1',
        amount: '400000',
        payment_date: '2026-04-15T00:00:00',
        manager: '담당',
        memo: '중도금',
        source: 'slack',
        external_id: 'sheet-1',
      },
      { id: 'pay-early', project_id: 'p1', amount: 100000, payment_date: '2026-03-01', payment_type: '계약금' },
      { id: 'pay-refund', project_id: 'p1', amount: -50000, payment_date: '2026-05-02', memo: '환불', source: 'manual' },
      { id: 'pay-none', project_id: null, amount: 999, payment_date: '2026-01-01', manager: '숨김' },
      { id: 'pay-bad-date', project_id: 'p1', amount: 1, payment_date: 'not-a-date' },
    ],
    items: [
      {
        project_id: 'p1',
        product_id: 'pr2',
        quantity: 1,
        created_at: '2026-02-01',
        unit_cost_snapshot: 9,
        unit_price_snapshot: 8,
      },
      {
        project_id: 'p1',
        product_id: 'pr1',
        quantity: '3',
        created_at: '2026-01-01',
        unit_cost_snapshot: 9,
      },
      { project_id: 'p1', product_id: null, quantity: 2, created_at: '2026-03-01' },
    ],
    products: [
      { id: 'pr1', category: 'Dcard', name: '디카드', current_cost: 10, price_vat_incl: 20 },
      { id: 'pr2', category: null, name: '직접상품', current_cost: 1 },
    ],
  })

  assert.equal(rows.length, 2)
  assert.equal(rows[0].project, '캠페인')
  assert.equal(rows[1].project, '이름만')
  assert.equal(rows[1].client, null)
  assert.deepEqual(Object.keys(rows[0]), [...STAFF_PROGRESS_COLUMNS])
  assert.deepEqual(rows[0].items.map((item) => Object.keys(item)), [
    [...STAFF_ITEM_COLUMNS],
    [...STAFF_ITEM_COLUMNS],
    [...STAFF_ITEM_COLUMNS],
  ])
  assert.deepEqual(Object.keys(rows[0].totals), [...TOTALS_COLUMNS])
  assert.equal(rows[0].client, '클라이언트')
  assert.equal(rows[0].contract_amount, 1500000.5)
  assert.equal(rows[0].paid_amount, 450000)
  assert.deepEqual(rows[0].payments.map((payment) => Object.keys(payment)), [
    [...STAFF_PAYMENT_COLUMNS],
    [...STAFF_PAYMENT_COLUMNS],
    [...STAFF_PAYMENT_COLUMNS],
  ])
  assert.deepEqual(rows[0].payments, [
    { paid_at: '2026-03-01', amount: 100000 },
    { paid_at: '2026-04-15', amount: 400000 },
    { paid_at: '2026-05-02', amount: -50000 },
  ])
  assert.deepEqual(rows[0].items, [
    { category: 'Dcard', product_name: '디카드', contracted: 3 },
    { category: null, product_name: '직접상품', contracted: 1 },
    { category: null, product_name: null, contracted: 2 },
  ])
  assert.deepEqual(rows[0].totals, { contracted: 6 })
  assert.deepEqual(rows[1].payments, [])
  assert.deepEqual(rows[1].items, [])
  assert.deepEqual(rows[1].totals, { contracted: 0 })

  const keys = collectKeys(rows)
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.has(forbidden), false, forbidden)
  }
  for (const hidden of ['id', 'project_id', 'payment_date']) {
    assert.equal(keys.has(hidden), false, hidden)
  }
})

test('select 문자열은 허용 열만 읽고 금지 열을 포함하지 않는다', () => {
  const selects = [PROJECT_SELECT, CLIENT_SELECT, PAYMENT_SELECT, ITEM_SELECT, PRODUCT_SELECT]
  assert.deepEqual(PROJECT_SELECT.split(','), ['id', 'client_id', 'name', 'status', 'contract_date', 'total_amount'])
  assert.deepEqual(CLIENT_SELECT.split(','), ['id', 'name'])
  assert.deepEqual(PAYMENT_SELECT.split(','), ['project_id', 'payment_date', 'amount'])
  for (const hidden of ['id', 'manager', 'memo', 'source', 'payment_type', 'external_id', 'client_name_raw', 'status']) {
    assert.equal(PAYMENT_SELECT.split(',').includes(hidden), false, hidden)
  }
  assert.deepEqual(ITEM_SELECT.split(','), ['project_id', 'product_id', 'quantity', 'created_at'])
  assert.deepEqual(PRODUCT_SELECT.split(','), ['id', 'category', 'name'])
  for (const forbidden of FORBIDDEN_KEYS) {
    for (const select of selects) {
      assert.equal(select.split(',').includes(forbidden), false, `${select} contains ${forbidden}`)
    }
  }
})

test('진행 라우트만 있고 마이그레이션·직원 API·담당 컬럼은 없다', () => {
  const route = readFileSync(join(root, 'src/app/api/integrations/staff-progress/route.ts'), 'utf8')
  assert.match(route, /PROJECT_SELECT/)
  assert.match(route, /CLIENT_SELECT/)
  assert.match(route, /PAYMENT_SELECT/)
  assert.match(route, /ITEM_SELECT/)
  assert.match(route, /PRODUCT_SELECT/)
  assert.match(route, /buildStaffProgress/)
  assert.equal(route.includes('employees'), false)
  assert.equal(route.includes('assignee'), false)
  assert.doesNotMatch(route, /\.select\(\s*['"`]\*/)
  assert.equal(existsSync(join(root, 'src/app/api/integrations/employees/route.ts')), false)
  assert.equal(existsSync(join(root, 'supabase/migrations/025_staff_project_progress.sql')), false)

  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(route.includes(forbidden), false, forbidden)
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

test('상태 필터만 받고 담당 쿼리는 쓰지 않는다', () => {
  assert.deepEqual(parseStaffProgressFilters(new URLSearchParams('status=ongoing&assignee=김하늘')), {
    ok: true,
    status: 'ongoing',
  })
  assert.deepEqual(parseStaffProgressFilters(new URLSearchParams('')), { ok: true, status: null })
  assert.deepEqual(parseStaffProgressFilters(new URLSearchParams('status=paused')), {
    ok: false,
    error: 'invalid_status',
  })
})
