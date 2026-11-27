import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { normalizeStatus } from '@/lib/google-sheets'
import {
  INVOICE_ISSUED, invoiceForRegistration, isCardStatus, isPaidInFullStatus, isSameSheetStatus, isUnpaidStatus,
  nextSheetStatusAfterDeposit, toDbStatus, toPaymentType, toSheetStatus,
} from './status'

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

test('normalizeStatus: 카드결제 미결제는 그대로 — 완료·미입금 등 다른 값으로 바뀌지 않는다', () => {
  assert.equal(normalizeStatus('카드결제 미결제'), '카드결제 미결제')
  assert.equal(normalizeStatus('카드결제미결제'), '카드결제 미결제')
  assert.equal(normalizeStatus('카드 결제 미결제'), '카드결제 미결제')
  // 기존 카드결제완료 해석은 그대로
  assert.equal(normalizeStatus('카드결제완료'), '카드결제완료')
  assert.equal(normalizeStatus('카드 결제 완료'), '카드결제완료')
})

test('toDbStatus: 카드결제 미결제는 미입금(unpaid)', () => {
  assert.equal(toDbStatus('카드결제 미결제'), 'unpaid')
})

test('toPaymentType: 카드결제 미결제는 미입금처럼 기타', () => {
  assert.equal(toPaymentType('카드결제 미결제'), '기타')
  assert.equal(toPaymentType('미입금'), '기타')
  assert.equal(toPaymentType('잔금 처리 요망'), '잔금')
  assert.equal(toPaymentType('입금완료'), null)
  assert.equal(toPaymentType('카드결제완료'), null)
  assert.equal(toPaymentType('추가계약'), null)
})

test('toSheetStatus: 미입금인데 시트가 카드결제 미결제면 유지', () => {
  assert.equal(toSheetStatus('unpaid', '카드결제 미결제'), '카드결제 미결제')
  assert.equal(toSheetStatus('unpaid'), '미입금')
  assert.equal(toSheetStatus('unpaid', '미입금'), '미입금')
  assert.equal(toSheetStatus('balance_due', '카드결제 미결제'), '잔금 처리 요망')
  assert.equal(toSheetStatus('confirmed', '카드결제 미결제'), '입금완료')
})

test('isCardStatus / isUnpaidStatus', () => {
  assert.equal(isCardStatus('카드결제완료'), true)
  assert.equal(isCardStatus('카드결제 미결제'), true)
  assert.equal(isCardStatus('입금완료'), false)
  assert.equal(isCardStatus('미입금'), false)
  assert.equal(isUnpaidStatus('카드결제 미결제'), true)
  assert.equal(isUnpaidStatus('미입금'), true)
  assert.equal(isUnpaidStatus('카드결제완료'), false)
  assert.equal(isPaidInFullStatus('카드결제 미결제'), false)
})

test('nextSheetStatusAfterDeposit: 카드 계열은 카드 상태로, 그 밖에는 기존대로', () => {
  assert.equal(nextSheetStatusAfterDeposit('카드결제 미결제', 0), '카드결제완료')
  assert.equal(nextSheetStatusAfterDeposit('카드결제 미결제', 1), '카드결제완료')
  assert.equal(nextSheetStatusAfterDeposit('카드결제 미결제', 500000), '카드결제 미결제')
  assert.equal(nextSheetStatusAfterDeposit('카드결제완료', 0), '카드결제완료')
  assert.equal(nextSheetStatusAfterDeposit('미입금', 0), '입금완료')
  assert.equal(nextSheetStatusAfterDeposit('미입금', 500000), '잔금 처리 요망')
  assert.equal(nextSheetStatusAfterDeposit('잔금 처리 요망', 0), '입금완료')
  // 시트 행을 못 읽은 경우 — 기존 폴백
  assert.equal(nextSheetStatusAfterDeposit(undefined, 0), '입금완료')
  assert.equal(nextSheetStatusAfterDeposit(undefined, 500000), '잔금 처리 요망')
  // 카드 미결제 → 카드결제완료 는 다시 써야 한다 (같은 상태 아님)
  assert.equal(isSameSheetStatus('카드결제 미결제', '카드결제완료'), false)
  assert.equal(isSameSheetStatus('카드결제 미결제', '카드결제 미결제'), true)
})

test('invoiceForRegistration: 카드 등록만 J열 발행완료, 그 밖에는 건드리지 않음', () => {
  assert.equal(INVOICE_ISSUED, '발행완료')
  assert.equal(invoiceForRegistration('카드결제완료'), '발행완료')
  assert.equal(invoiceForRegistration('카드결제 미결제'), '발행완료')
  assert.equal(invoiceForRegistration('입금완료'), undefined)
  assert.equal(invoiceForRegistration('미입금'), undefined)
  assert.equal(invoiceForRegistration('잔금 처리 요망'), undefined)
  assert.equal(invoiceForRegistration('추가계약'), undefined)
})
