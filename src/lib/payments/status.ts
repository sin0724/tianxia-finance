/**
 * 시트 I열 입금상태 ↔ payments.status 매핑 — 등록·수정·동기화·되돌리기가 모두 이 한 곳을 쓴다.
 */
import type { PaymentStatus } from '@/lib/google-sheets'

export type DbPaymentStatus = 'confirmed' | 'balance_due' | 'unpaid'

/** 완납 상태 — 카드결제완료는 입금완료와 똑같이 다 받은 건이다 */
export const isPaidInFullStatus = (s: string): s is '입금완료' | '카드결제완료' =>
  s === '입금완료' || s === '카드결제완료'

/** 미입금 상태 — '카드결제 미결제'(카드로 하기로 했지만 아직 승인 전)는 미입금과 똑같이 본다 */
export const isUnpaidStatus = (s: string): s is '미입금' | '카드결제 미결제' =>
  s === '미입금' || s === '카드결제 미결제'

/** 카드 결제 계열 — 세금계산서가 필요 없다 */
export const isCardStatus = (s: string): s is '카드결제완료' | '카드결제 미결제' =>
  s === '카드결제완료' || s === '카드결제 미결제'

/** 시트 입금상태 → DB 상태. '입금완료'·'카드결제완료'·'추가계약'은 확정, '카드결제 미결제'는 미입금 */
export const toDbStatus = (s: PaymentStatus): DbPaymentStatus =>
  s === '잔금 처리 요망' ? 'balance_due' : isUnpaidStatus(s) ? 'unpaid' : 'confirmed'

/** 결제 payment_type — 잔금은 '잔금', 미입금(카드결제 미결제 포함)은 '기타', 그 밖은 비움 */
export const toPaymentType = (s: PaymentStatus): '잔금' | '기타' | null =>
  s === '잔금 처리 요망' ? '잔금' : isUnpaidStatus(s) ? '기타' : null

/**
 * DB 상태 → 시트 I열 드롭다운 값 (toDbStatus 의 반대 방향). 그 밖의 값은 '입금완료'.
 * current(지금 시트 값)가 '카드결제완료'이고 확정이면 그대로 둔다 — 카드 완납 행을 입금완료로 덮어쓰지 않게.
 * current 가 '카드결제 미결제'이고 미입금이어도 그대로 둔다 — 미입금으로 덮어쓰지 않게.
 */
export const toSheetStatus = (s: DbPaymentStatus | string, current?: PaymentStatus): PaymentStatus => {
  if (s === 'balance_due') return '잔금 처리 요망'
  if (s === 'unpaid') return current === '카드결제 미결제' ? '카드결제 미결제' : '미입금'
  return current === '카드결제완료' ? '카드결제완료' : '입금완료'
}

/**
 * 입금 확정 뒤 I열에 쓸 값. remainingPending 은 앱에 남은 수금 예정 금액.
 * 지금 시트 값이 카드 계열이면 카드 상태를 유지한다 — 다 받았으면 '카드결제완료', 남았으면 '카드결제 미결제'.
 * 그 밖에는 다 받았으면 '입금완료', 남았으면 '잔금 처리 요망'. 시트 값을 모르면(current 없음) 카드가 아닌 쪽.
 */
export const nextSheetStatusAfterDeposit = (
  current: PaymentStatus | undefined,
  remainingPending: number,
): PaymentStatus => {
  const paidInFull = remainingPending <= 1
  if (current && isCardStatus(current)) return paidInFull ? '카드결제완료' : '카드결제 미결제'
  return paidInFull ? '입금완료' : '잔금 처리 요망'
}

/**
 * I열을 다시 쓸 필요가 없는지 — 같은 값이거나 둘 다 완납이면 같다고 본다.
 * 앱은 완납을 '입금완료'로 쓰는데 시트가 이미 '카드결제완료'면 그대로 둬야 한다.
 */
export const isSameSheetStatus = (current: PaymentStatus, next: PaymentStatus): boolean =>
  current === next || (isPaidInFullStatus(current) && isPaidInFullStatus(next))

/** 시트 J열(계산서)의 발행완료 값 — 드롭다운 선택지와 글자가 같아야 한다 */
export const INVOICE_ISSUED = '발행완료'

/**
 * /결제 등록 때 J열(계산서)에 쓸 값. 카드 결제는 세금계산서가 필요 없어 '발행완료'로 적는다.
 * 카드가 아니면 undefined — J열을 건드리지 않는다.
 */
export const invoiceForRegistration = (s: PaymentStatus): string | undefined =>
  isCardStatus(s) ? INVOICE_ISSUED : undefined
