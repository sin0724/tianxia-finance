/**
 * 시트 I열 입금상태 ↔ payments.status 매핑 — 등록·수정·동기화·되돌리기가 모두 이 한 곳을 쓴다.
 */
import type { PaymentStatus } from '@/lib/google-sheets'

export type DbPaymentStatus = 'confirmed' | 'balance_due' | 'unpaid'

/** 완납 상태 — 카드결제완료는 입금완료와 똑같이 다 받은 건이다 */
export const isPaidInFullStatus = (s: string): s is '입금완료' | '카드결제완료' =>
  s === '입금완료' || s === '카드결제완료'

/** 시트 입금상태 → DB 상태. '입금완료'·'카드결제완료'·'추가계약'은 확정으로 본다 */
export const toDbStatus = (s: PaymentStatus): DbPaymentStatus =>
  s === '잔금 처리 요망' ? 'balance_due' : s === '미입금' ? 'unpaid' : 'confirmed'

/**
 * DB 상태 → 시트 I열 드롭다운 값 (toDbStatus 의 반대 방향). 그 밖의 값은 '입금완료'.
 * current(지금 시트 값)가 '카드결제완료'이고 확정이면 그대로 둔다 — 카드 완납 행을 입금완료로 덮어쓰지 않게.
 */
export const toSheetStatus = (s: DbPaymentStatus | string, current?: PaymentStatus): PaymentStatus => {
  if (s === 'balance_due') return '잔금 처리 요망'
  if (s === 'unpaid') return '미입금'
  return current === '카드결제완료' ? '카드결제완료' : '입금완료'
}

/**
 * I열을 다시 쓸 필요가 없는지 — 같은 값이거나 둘 다 완납이면 같다고 본다.
 * 앱은 완납을 '입금완료'로 쓰는데 시트가 이미 '카드결제완료'면 그대로 둬야 한다.
 */
export const isSameSheetStatus = (current: PaymentStatus, next: PaymentStatus): boolean =>
  current === next || (isPaidInFullStatus(current) && isPaidInFullStatus(next))
