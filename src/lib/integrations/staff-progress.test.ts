import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { kstToday } from '../kst'
import {
  DELIVERY_COLUMNS,
  DELIVERY_SELECT,
  EMPLOYEE_COLUMNS,
  EMPLOYEE_SELECT,
  ITEM_LOOKUP_SELECT,
  PRODUCT_CATEGORY_SELECT,
  STAFF_ITEM_COLUMNS,
  STAFF_PROGRESS_COLUMNS,
  STAFF_PROGRESS_SELECT,
  isStaffProgressAuthorized,
  matchItemIdsByCategory,
  parseDeliveryBody,
  parseStaffProgressFilters,
  shapeDelivery,
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

test('진행 피드 응답 키는 허용 목록과 같고 금지 키를 버리며 수량을 숫자로 만든다', () => {
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
    contracted: 3,
    delivered: '1',
    remaining: 2,
    base_salary: 9_000_000,
    current_cost: 10,
    hourly_wage: 12000,
    unit_cost_snapshot: 100,
    margin: 40,
    memo: '내부 메모',
    items: JSON.stringify([
      {
        project_item_id: 'i1',
        category: 'Dcard',
        product_name: '디카드',
        contracted: 3,
        delivered: '1',
        remaining: 2,
        unit_cost_snapshot: 100,
        unit_price_snapshot: 200,
        margin: 50,
        base_salary: 1,
      },
    ]),
  })

  assert.deepEqual(Object.keys(shaped), [...STAFF_PROGRESS_COLUMNS])
  assert.deepEqual(Object.keys(shaped.items[0]), [...STAFF_ITEM_COLUMNS])
  assert.equal(shaped.contract_amount, 1500000.5)
  assert.equal(shaped.paid_amount, 500000)
  assert.equal(shaped.items[0].delivered, 1)
  assert.equal(shaped.items[0].category, 'Dcard')

  const keys = collectKeys(shaped)
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.has(forbidden), false, forbidden)
  }
})

test('직원·납품 응답도 id/이름과 납품 열만 남긴다', () => {
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

  const delivery = shapeDelivery({
    id: 'd1',
    project_item_id: 'i1',
    quantity: 2,
    delivered_at: '2026-10-30',
    note: null,
    source: 'api',
    external_key: 'ext-1',
    created_at: '2026-10-30T00:00:00Z',
    unit_cost_snapshot: 10,
    current_cost: 10,
  })
  assert.deepEqual(Object.keys(delivery), [...DELIVERY_COLUMNS])
  assert.equal(collectKeys(delivery).has('unit_cost_snapshot'), false)
})

test('select 문자열은 허용 컬럼과 같고 금지 컬럼을 포함하지 않는다', () => {
  assert.equal(STAFF_PROGRESS_SELECT, STAFF_PROGRESS_COLUMNS.join(','))
  assert.equal(DELIVERY_SELECT, DELIVERY_COLUMNS.join(','))
  assert.equal(EMPLOYEE_SELECT, EMPLOYEE_COLUMNS.join(','))

  const selects = [STAFF_PROGRESS_SELECT, DELIVERY_SELECT, EMPLOYEE_SELECT, ITEM_LOOKUP_SELECT, PRODUCT_CATEGORY_SELECT]
  for (const forbidden of FORBIDDEN_KEYS) {
    for (const select of selects) {
      assert.equal(select.split(',').includes(forbidden), false, `${select} contains ${forbidden}`)
    }
  }
  assert.deepEqual(ITEM_LOOKUP_SELECT.split(','), ['id', 'product_id'])
  assert.deepEqual(PRODUCT_CATEGORY_SELECT.split(','), ['id', 'category'])
})

test('연동 라우트 소스는 허용 select 와 직렬화만 쓰고 금지 컬럼을 읽지 않는다', () => {
  const files = [
    'src/app/api/integrations/staff-progress/route.ts',
    'src/app/api/integrations/deliveries/route.ts',
    'src/app/api/integrations/employees/route.ts',
  ].map((file) => readFileSync(join(root, file), 'utf8'))

  const combined = files.join('\n')
  assert.match(files[0], /STAFF_PROGRESS_SELECT/)
  assert.match(files[0], /shapeStaffProgress/)
  assert.match(files[1], /DELIVERY_SELECT/)
  assert.match(files[1], /ITEM_LOOKUP_SELECT/)
  assert.match(files[1], /PRODUCT_CATEGORY_SELECT/)
  assert.match(files[1], /shapeDelivery/)
  assert.match(files[2], /EMPLOYEE_SELECT/)
  assert.match(files[2], /shapeEmployee/)
  assert.doesNotMatch(combined, /\.select\(\s*['"`]\*/)

  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(combined.includes(forbidden), false, forbidden)
  }
})

test('뷰 정의는 security invoker 이고 금지 컬럼을 조회하지 않는다', () => {
  const sql = readFileSync(join(root, 'supabase/migrations/025_staff_project_progress.sql'), 'utf8')
  const view = sql.slice(sql.indexOf('CREATE OR REPLACE VIEW staff_project_progress'))
  assert.match(view, /security_invoker = true/)
  assert.match(sql, /assignee_employee_id uuid/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS project_deliveries/)
  assert.match(sql, /quantity\s+integer NOT NULL CHECK \(quantity > 0\)/)
  assert.match(sql, /Asia\/Seoul/)
  assert.match(sql, /external_key\s+text UNIQUE/)
  assert.match(sql, /POLICY "authenticated_all" ON project_deliveries/)
  assert.match(view, /e\.name AS assignee_name/)
  for (const column of STAFF_PROGRESS_COLUMNS) {
    assert.match(view, new RegExp(`\\b${column}\\b`))
  }
  for (const forbidden of FORBIDDEN_KEYS) {
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
        headers: { authorization: 'Bearer staff-secret-longer' },
      })),
      false,
    )
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
  assert.deepEqual(parseStaffProgressFilters(new URLSearchParams('status=&assignee=')), {
    ok: true, status: null, assigneeId: null, assigneeName: null,
  })
  assert.deepEqual(parseStaffProgressFilters(new URLSearchParams('status=paused')), {
    ok: false, error: 'invalid_status',
  })
})

test('납품 본문은 대상·수량만 받아들이고 금액 필드는 결과에 담지 않는다', () => {
  const itemId = '22222222-2222-4222-8222-222222222222'
  const projectId = '33333333-3333-4333-8333-333333333333'
  const byItem = parseDeliveryBody({
    project_item_id: itemId,
    project_id: projectId,
    category: 'Dcard',
    quantity: 2,
    delivered_at: '2026-10-30',
    note: '  1차  ',
    external_key: '  sheet-1  ',
    unit_cost_snapshot: 900,
    base_salary: 100,
  })
  assert.equal(byItem.ok, true)
  if (byItem.ok) {
    assert.deepEqual(byItem.value, {
      projectItemId: itemId,
      projectId: null,
      category: null,
      quantity: 2,
      deliveredAt: '2026-10-30',
      note: '1차',
      externalKey: 'sheet-1',
    })
    assert.equal('unit_cost_snapshot' in byItem.value, false)
  }

  const byCategory = parseDeliveryBody({ project_id: projectId, category: ' Dcard ', quantity: 1 })
  assert.equal(byCategory.ok, true)
  if (byCategory.ok) {
    assert.equal(byCategory.value.projectId, projectId)
    assert.equal(byCategory.value.category, 'Dcard')
    assert.equal(byCategory.value.deliveredAt, null)
    assert.equal(byCategory.value.externalKey, null)
  }

  assert.equal(parseDeliveryBody({ quantity: 1 }).ok, false)
  assert.equal(parseDeliveryBody({ project_item_id: itemId, quantity: 0 }).ok, false)
  assert.equal(parseDeliveryBody({ project_item_id: itemId, quantity: 1.5 }).ok, false)
  assert.equal(parseDeliveryBody({ project_item_id: itemId, quantity: 1, delivered_at: '2026-02-31' }).ok, false)
  assert.equal(parseDeliveryBody([]).ok, false)
})

test('카테고리가 같은 항목이 둘이면 둘 다 돌려준다', () => {
  const matched = matchItemIdsByCategory([
    { id: 'a', category: 'Dcard' },
    { id: 'b', category: ' Dcard ' },
    { id: 'c', category: 'PTT' },
    { id: 'd', category: null },
  ], 'Dcard')
  assert.deepEqual(matched, ['a', 'b'])
  assert.deepEqual(matchItemIdsByCategory([{ id: 'a', category: 'Dcard' }], 'dcard'), [])
})

test('날짜가 비어 있으면 한국 오늘을 쓴다', () => {
  assert.equal(kstToday(new Date('2026-10-30T14:59:00Z')), '2026-10-30')
  assert.equal(kstToday(new Date('2026-10-30T15:00:00Z')), '2026-10-31')
})
