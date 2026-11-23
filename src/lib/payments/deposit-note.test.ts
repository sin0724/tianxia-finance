import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { appendNoteLine, formatDepositNoteLine, replaceNoteLine } from './deposit-note'

test('formatDepositNoteLine: 월·일 앞자리 0 없이, 금액은 천 단위 쉼표', () => {
  assert.equal(formatDepositNoteLine('2026-11-20', 1980000), '11/20 입금완료 1,980,000원')
})

test('formatDepositNoteLine: 한 자리 월·일', () => {
  assert.equal(formatDepositNoteLine('2026-01-05', 500000), '1/5 입금완료 500,000원')
})

test('formatDepositNoteLine: 천 원 미만 금액', () => {
  assert.equal(formatDepositNoteLine('2026-12-31', 900), '12/31 입금완료 900원')
})

test('formatDepositNoteLine: 잘못된 날짜는 예외', () => {
  assert.throws(() => formatDepositNoteLine('11/20', 1000))
})

test('appendNoteLine: 빈 메모면 그 줄만', () => {
  assert.equal(appendNoteLine('', 'a'), 'a')
})

test('appendNoteLine: 기존 메모 뒤에 줄바꿈으로', () => {
  assert.equal(appendNoteLine('기존 메모', '11/20 입금완료 1,000원'), '기존 메모\n11/20 입금완료 1,000원')
})

test('replaceNoteLine: 정확히 같은 줄을 바꾼다', () => {
  const r = replaceNoteLine('메모\n11/20 입금완료 1,000원\n11/25 입금완료 2,000원', '11/20 입금완료 1,000원', '11/21 입금완료 1,500원')
  assert.equal(r.result, 'replaced')
  assert.equal(r.note, '메모\n11/21 입금완료 1,500원\n11/25 입금완료 2,000원')
})

test('replaceNoteLine: 줄의 일부만 같으면 바꾸지 않고 덧붙인다', () => {
  const r = replaceNoteLine('11/20 입금완료 1,000원 (계좌)', '11/20 입금완료 1,000원', '11/20 입금완료 2,000원')
  assert.equal(r.result, 'appended')
  assert.equal(r.note, '11/20 입금완료 1,000원 (계좌)\n11/20 입금완료 2,000원')
})

test('replaceNoteLine: 빈 메모면 덧붙인다', () => {
  assert.deepEqual(replaceNoteLine('', 'a', 'b'), { note: 'b', result: 'appended' })
})
