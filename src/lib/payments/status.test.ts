import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { normalizeStatus } from '@/lib/google-sheets'
import { isPaidInFullStatus, isSameSheetStatus, toDbStatus, toSheetStatus } from './status'

test('normalizeStatus: 시트 드롭다운 값', () => {
  assert.equal(normalizeStatus('입금완료'), '입금완료')
  assert.equal(normalizeStatus('카드결제완료'), '카드결제완료')
  assert.equal(normalizeStatus('미입금'), '미입금')
  assert.equal(normalizeStatus('잔금 처리 요망'), '잔금 처리 요망')
  assert.equal(normalizeStatus('추가/재계약'), '추가계약')
  // 기존 동작 유지 — 빈 값·알 수 없는 값은 입금완료
  assert.equal(normalizeStatus(''), '입금완료')
  assert.equal(normalizeStatus('완납'), '입금완료')
})

test('toDbStatus: 카드결제완료는 확정', () => {
  assert.equal(toDbStatus('카드결제완료'), 'confirmed')
  assert.equal(toDbStatus('입금완료'), 'confirmed')
  assert.equal(toDbStatus('추가계약'), 'confirmed')
  assert.equal(toDbStatus('잔금 처리 요망'), 'balance_due')
  assert.equal(toDbStatus('미입금'), 'unpaid')
})

test('toSheetStatus: 확정 기본값은 입금완료, 시트가 카드결제완료면 유지', () => {
  assert.equal(toSheetStatus('confirmed'), '입금완료')
  assert.equal(toSheetStatus('confirmed', '입금완료'), '입금완료')
  assert.equal(toSheetStatus('confirmed', '카드결제완료'), '카드결제완료')
  assert.equal(toSheetStatus('balance_due', '카드결제완료'), '잔금 처리 요망')
  assert.equal(toSheetStatus('unpaid', '카드결제완료'), '미입금')
})

test('isSameSheetStatus: 완납끼리는 같다고 보고 I열을 덮어쓰지 않는다', () => {
  assert.equal(isSameSheetStatus('카드결제완료', '입금완료'), true)
  assert.equal(isSameSheetStatus('입금완료', '입금완료'), true)
  assert.equal(isSameSheetStatus('카드결제완료', '잔금 처리 요망'), false)
  assert.equal(isSameSheetStatus('잔금 처리 요망', '입금완료'), false)
  assert.equal(isSameSheetStatus('추가계약', '입금완료'), false)
})

test('isPaidInFullStatus', () => {
  assert.equal(isPaidInFullStatus('카드결제완료'), true)
  assert.equal(isPaidInFullStatus('입금완료'), true)
  assert.equal(isPaidInFullStatus('추가계약'), false)
  assert.equal(isPaidInFullStatus('잔금 처리 요망'), false)
})
