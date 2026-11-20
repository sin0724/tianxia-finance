import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { canEditPayment } from './edit'

test('canEditPayment: 본인은 수정 가능', () => {
  assert.ok(canEditPayment('U123', 'U123'))
})

test('canEditPayment: 다른 사람은 수정 불가', () => {
  const oldEnv = process.env.PAYMENT_EDIT_ADMINS
  delete process.env.PAYMENT_EDIT_ADMINS
  try {
    assert.ok(!canEditPayment('U999', 'U123'))
  } finally {
    if (oldEnv !== undefined) process.env.PAYMENT_EDIT_ADMINS = oldEnv
  }
})

test('canEditPayment: 기본 관리자(신현준)는 수정 가능', () => {
  const oldEnv = process.env.PAYMENT_EDIT_ADMINS
  delete process.env.PAYMENT_EDIT_ADMINS
  try {
    assert.ok(canEditPayment('U0AHE6BR86P', 'U123'))
  } finally {
    if (oldEnv !== undefined) process.env.PAYMENT_EDIT_ADMINS = oldEnv
  }
})

test('canEditPayment: 환경변수에 추가된 관리자는 수정 가능', () => {
  const oldEnv = process.env.PAYMENT_EDIT_ADMINS
  process.env.PAYMENT_EDIT_ADMINS = 'UADMIN1,UADMIN2'
  try {
    assert.ok(canEditPayment('UADMIN1', 'U123'))
    assert.ok(canEditPayment('UADMIN2', 'U123'))
    assert.ok(!canEditPayment('UOTHER', 'U123'))
  } finally {
    if (oldEnv !== undefined) process.env.PAYMENT_EDIT_ADMINS = oldEnv
  }
})
