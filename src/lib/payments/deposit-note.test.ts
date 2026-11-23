import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { appendNoteLine, findDepositInNote, formatDepositNoteLine, removeAccountedLines, replaceNoteLine } from './deposit-note'

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

test('findDepositInNote: 앱이 쓰는 형식의 줄에서 입금일을 찾는다', () => {
  assert.deepEqual(findDepositInNote('11/20 입금완료 1,980,000원', 1980000, '2026-11-23'), { date: '2026-11-20', lineIndex: 0 })
})

test('findDepositInNote: 금액이 같은 줄 중 마지막 줄', () => {
  const note = '선금 받음\n11/3 입금완료 500,000원\n11/10 입금완료 1,000,000원\n11/20 입금완료 500,000원'
  assert.deepEqual(findDepositInNote(note, 500000, '2026-11-23'), { date: '2026-11-20', lineIndex: 3 })
  assert.deepEqual(findDepositInNote(note, 1000000, '2026-11-23'), { date: '2026-11-10', lineIndex: 2 })
})

test('findDepositInNote: 앞뒤 공백·\r, 쉼표 없는 금액, 원 생략', () => {
  assert.equal(findDepositInNote('  11/5입금완료 1980000원 \r', 1980000, '2026-11-23')?.date, '2026-11-05')
  assert.equal(findDepositInNote('11/5 입금완료 1,980,000', 1980000, '2026-11-23')?.date, '2026-11-05')
})

test('findDepositInNote: 만원 단위 손글씨 형식은 인정하지 않는다', () => {
  assert.equal(findDepositInNote('11/5 입금완료 8250만원', 82500000, '2026-11-23'), null)
  assert.equal(findDepositInNote('11/5 입금완료 8250만원', 8250, '2026-11-23'), null)
})

test('findDepositInNote: 금액이 다르거나 형식이 다르면 null', () => {
  assert.equal(findDepositInNote('11/20 입금완료 1,980,000원', 1000000, '2026-11-23'), null)
  assert.equal(findDepositInNote('입금완료 1,980,000원', 1980000, '2026-11-23'), null)
  assert.equal(findDepositInNote('', 1980000, '2026-11-23'), null)
  assert.equal(findDepositInNote('13/1 입금완료 1,000원', 1000, '2026-11-23'), null)
})

test('findDepositInNote: 동기화 날짜보다 뒤인 날짜는 전년도', () => {
  assert.equal(findDepositInNote('12/28 입금완료 300,000원', 300000, '2027-01-03')?.date, '2026-12-28')
  assert.equal(findDepositInNote('1/3 입금완료 300,000원', 300000, '2027-01-03')?.date, '2027-01-03')
})

test('findDepositInNote: 2/29 는 그 해에 있을 때만', () => {
  assert.equal(findDepositInNote('2/29 입금완료 1,000원', 1000, '2029-01-10')?.date, '2028-02-29')
  assert.equal(findDepositInNote('2/29 입금완료 1,000원', 1000, '2027-03-01'), null)
})

test('removeAccountedLines: 힐링페이퍼 — 앞서 확정한 같은 금액 줄을 지우면 잔여분은 못 찾는다', () => {
  const note = '11/20 입금완료 1,980,000원'
  const working = removeAccountedLines(note, [{ amount: 1980000, paymentDate: '2026-11-20' }])
  assert.equal(working, '')
  assert.equal(findDepositInNote(working, 1980000, '2026-11-23'), null)
})

test('removeAccountedLines: 잔여분 줄이 따로 있으면 그 줄을 찾는다', () => {
  const note = '11/20 입금완료 1,980,000원\n12/5 입금완료 1,980,000원'
  const working = removeAccountedLines(note, [{ amount: 1980000, paymentDate: '2026-11-20' }])
  assert.equal(working, '12/5 입금완료 1,980,000원')
  assert.equal(findDepositInNote(working, 1980000, '2026-12-10')?.date, '2026-12-05')
})

test('removeAccountedLines: 확정 건 하나당 한 줄만, 날짜·금액이 모두 같아야 지운다', () => {
  const note = '메모\n11/20 입금완료 500,000원\n11/20 입금완료 500,000원\n11/21 입금완료 300,000원'
  assert.equal(
    removeAccountedLines(note, [{ amount: 500000, paymentDate: '2026-11-20' }]),
    '메모\n11/20 입금완료 500,000원\n11/21 입금완료 300,000원',
  )
  assert.equal(removeAccountedLines(note, [{ amount: 300000, paymentDate: '2026-11-20' }]), note)
  assert.equal(removeAccountedLines(note, [{ amount: 500000, paymentDate: '2026-11-21' }]), note)
  assert.equal(removeAccountedLines(note, []), note)
  assert.equal(removeAccountedLines('', [{ amount: 1, paymentDate: '2026-11-20' }]), '')
})
