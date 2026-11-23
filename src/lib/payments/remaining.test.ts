import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { baseSyncId, computeRemaining, isInSyncGroup } from './remaining'

test('baseSyncId: 원래 건은 그대로', () => {
  assert.equal(baseSyncId('tx_abc'), 'tx_abc')
})

test('baseSyncId: 잔여분은 # 앞부분', () => {
  assert.equal(baseSyncId('tx_abc#1234abcd'), 'tx_abc')
})

test('baseSyncId: tx_ 가 아니면 null', () => {
  assert.equal(baseSyncId('sheet_2026-01-01_x'), null)
  assert.equal(baseSyncId(null), null)
  assert.equal(baseSyncId(''), null)
})

test('isInSyncGroup: 원래 건·잔여분만 포함', () => {
  assert.ok(isInSyncGroup('tx_abc', 'tx_abc'))
  assert.ok(isInSyncGroup('tx_abc#12345678', 'tx_abc'))
  assert.ok(!isInSyncGroup('tx_abcd', 'tx_abc'))
  assert.ok(!isInSyncGroup(null, 'tx_abc'))
})

test('computeRemaining: 확정 건만 뺀다', () => {
  assert.equal(computeRemaining(3_000_000, [
    { amount: 1_980_000, status: 'confirmed' },
    { amount: 1_020_000, status: 'balance_due' },
  ]), 1_020_000)
})

test('computeRemaining: 여러 번 나눠 입금', () => {
  assert.equal(computeRemaining(1_000_000, [
    { amount: 300_000, status: 'confirmed' },
    { amount: 300_000, status: 'confirmed' },
    { amount: 400_000, status: 'unpaid' },
  ]), 400_000)
})

test('computeRemaining: 환불(음수)도 그대로 합산', () => {
  assert.equal(computeRemaining(1_000_000, [
    { amount: 1_000_000, status: 'confirmed' },
    { amount: -200_000, status: 'confirmed' },
  ]), 200_000)
})

test('computeRemaining: 초과 입금이면 음수', () => {
  assert.equal(computeRemaining(1_000_000, [{ amount: 1_100_000, status: 'confirmed' }]), -100_000)
})

test('computeRemaining: 빈 그룹은 시트 금액 그대로', () => {
  assert.equal(computeRemaining(500_000, []), 500_000)
})
