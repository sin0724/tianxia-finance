/**
 * 시트 I열 입금상태 ↔ payments.status 매핑 — 등록·수정·동기화·되돌리기가 모두 이 한 곳을 쓴다.
 */
import type { PaymentStatus } from '@/lib/google-sheets'

export type DbPaymentStatus = 'confirmed' | 'balance_due' | 'unpaid'

/** 시트 입금상태 → DB 상태. '입금완료'·'추가계약'은 확정으로 본다 */
export const toDbStatus = (s: PaymentStatus): DbPaymentStatus =>
  s === '잔금 처리 요망' ? 'balance_due' : s === '미입금' ? 'unpaid' : 'confirmed'

/** DB 상태 → 시트 I열 드롭다운 값 (toDbStatus 의 반대 방향). 그 밖의 값은 '입금완료' */
export const toSheetStatus = (s: DbPaymentStatus | string): PaymentStatus =>
  s === 'balance_due' ? '잔금 처리 요망' : s === 'unpaid' ? '미입금' : '입금완료'
