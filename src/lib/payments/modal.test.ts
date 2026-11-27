import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { PaymentStatus } from '@/lib/google-sheets'
import { FIELD, buildPaymentEditModal, buildPaymentModal, editStatusOptions } from './modal'

type Block = { block_id?: string; element?: { options?: { value: string }[]; initial_option?: { value: string } } }

function statusValues(modal: Record<string, unknown>): string[] {
  const block = (modal.blocks as Block[]).find(b => b.block_id === FIELD.status)
  return (block?.element?.options ?? []).map(o => o.value)
}

const FINAL = ['입금완료', '카드결제완료', '카드결제 미결제', '잔금 처리 요망', '미입금']

test('등록 모달 입금상태: 추가계약 없이 5개', () => {
  const modal = buildPaymentModal({ today: '2026-11-27', managers: [], channelId: 'C', userId: 'U' })
  assert.deepEqual(statusValues(modal), FINAL)
})

const editModal = (status: PaymentStatus) => buildPaymentEditModal({
  current: { date: '2026-11-27', clientName: 'A', representative: '', phone: '', manager: '', amount: 1000, status, memo: '' },
  managers: [], channelId: 'C', messageTs: '1', syncId: 's', registrantUserId: 'U', canEditAmountDate: true,
})

test('수정 모달 입금상태: 일반 값이면 추가계약 없음', () => {
  assert.deepEqual(statusValues(editModal('미입금')), FINAL)
})

test('수정 모달 입금상태: 기존 값이 추가계약이면 그 값만 덧붙여 모달이 열리게', () => {
  assert.deepEqual(statusValues(editModal('추가계약')), [...FINAL, '추가계약'])
  assert.deepEqual(editStatusOptions('입금완료'), FINAL)
})
