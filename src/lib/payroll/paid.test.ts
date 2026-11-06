import assert from 'node:assert/strict'
import test from 'node:test'
import { payAttribution, paidStatus, transfersByEmployee, type PayTransfer } from './paid'

const tx = (tx_date: string, counterparty: string, memo: string, withdrawal: number): PayTransfer =>
  ({ tx_date, counterparty, memo, withdrawal })

test('메모의 달이 귀속월이고, 없으면 지급일 전달이다', () => {
  assert.deepEqual(payAttribution({ tx_date: '2026-10-09', memo: '9월　급여' }), { year: 2026, month: 9 })
  assert.deepEqual(payAttribution({ tx_date: '2026-10-10', memo: '10월　퇴사자　급여' }), { year: 2026, month: 10 })
  assert.deepEqual(payAttribution({ tx_date: '2027-01-10', memo: '12월 급여' }), { year: 2026, month: 12 })
  assert.deepEqual(payAttribution({ tx_date: '2026-09-14', memo: '퇴사자 급여' }), { year: 2026, month: 8 })
  assert.deepEqual(payAttribution({ tx_date: '2027-01-14', memo: '퇴사자 급여' }), { year: 2026, month: 12 })
})

test('실명·영문 예금주명·전각 공백 표시를 직원에 붙이고 귀속월만 고른다', () => {
  const employees = [
    { id: 'a', name: '김하나', bank_name: 'KIM HA NA' },
    { id: 'b', name: '박둘', bank_name: null },
  ]
  const found = transfersByEmployee(employees, [
    tx('2026-10-10', 'KIM　HA　NA', '10월　퇴사자　급여', 700_000),
    tx('2026-11-10', '박둘', '10월 급여', 100),
    tx('2026-11-10', '박둘', '10월 수당', 200),
    tx('2026-10-09', '박둘', '9월 급여', 999),
    tx('2026-11-10', '모르는사람', '10월 급여', 5),
  ], 2026, 10)
  assert.deepEqual(found.get('a')?.map((t) => t.withdrawal), [700_000])
  assert.deepEqual(found.get('b')?.map((t) => t.withdrawal), [100, 200])
  assert.equal(found.size, 2)
})

test('지급 상태와 잔액을 계산한다', () => {
  const sent = (n: number) => [tx('2026-10-10', '김하나', '10월 급여', n)]
  assert.deepEqual(
    (({ state, remaining, over }) => ({ state, remaining, over }))(paidStatus(1000, [], null)),
    { state: 'unpaid', remaining: 1000, over: 0 },
  )
  assert.equal(paidStatus(1000, sent(1000), null).state, 'paid')
  assert.equal(paidStatus(1000, sent(400), null).remaining, 600)
  assert.equal(paidStatus(1000, sent(400), null).state, 'partial')
  assert.equal(paidStatus(1000, sent(1200), null).over, 200)
  assert.equal(paidStatus(1000, sent(1200), null).state, 'over')
  // 체크하면 통장에서 못 찾은 잔액도 더 보낼 돈이 아니다
  const checked = paidStatus(1000, sent(400), '2026-11-06')
  assert.equal(checked.state, 'checked')
  assert.equal(checked.remaining, 0)
})
