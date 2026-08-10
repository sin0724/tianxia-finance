/**
 * 사업소득 원천징수 계산 — (주)티엔샤 사업소득지급대장 기준
 *
 * 세무사가 회신하는 대장의 세액은 다음 규칙으로 100% 재현된다
 * (2026.08 대장 12명 전원 검증):
 *   소득세     = 내림(지급액 × 3%, 10원 단위)
 *   지방소득세 = 내림(소득세 × 10%, 10원 단위)
 *   차인지급액 = 지급액 − 소득세 − 지방소득세
 *
 * 예) 594,000원 → 소득세 17,820 / 지방소득세 1,782→1,780 / 차인지급액 574,400
 *
 * 다만 이 값은 어디까지나 **검산용 제안값**이다. 실제 대장은 세무사가 확정하며
 * 앱에 기록되는 진실은 ③ 확정 단계에서 받아 적은 값이다.
 * (4대보험 가입자·연말정산 반영 등으로 달라질 수 있다.)
 */

export const BUSINESS_INCOME_TAX_RATE = 0.03
export const LOCAL_INCOME_TAX_RATE = 0.1

/** 10원 미만 절사 */
function floorTo10(n: number): number {
  return Math.floor(n / 10) * 10
}

export interface Withholding {
  /** 소득세 (3%) */
  incomeTax: number
  /** 지방소득세 (소득세의 10%) */
  localTax: number
  /** 원천징수 합계 */
  totalTax: number
  /** 차인지급액 (세후) */
  net: number
}

/** 세전 지급액에 대한 사업소득 3.3% 원천징수를 계산한다. */
export function withhold(gross: number): Withholding {
  const g = Math.max(0, Math.round(gross))
  const incomeTax = floorTo10(g * BUSINESS_INCOME_TAX_RATE)
  const localTax = floorTo10(incomeTax * LOCAL_INCOME_TAX_RATE)
  return { incomeTax, localTax, totalTax: incomeTax + localTax, net: g - incomeTax - localTax }
}

/**
 * 아르바이트 급여 산정 — 시급 × 근무시간 + 주휴수당
 * 주 평균 15시간 이상이면 주휴수당(시급분의 20%) 대상.
 */
export function calcPartTimePay(hours: number, hourlyWage: number, includeHoliday = true) {
  const hourlyPay = Math.round(hours * hourlyWage)
  const weeklyAvgHours = hours / 4.345
  const eligible = weeklyAvgHours >= 15
  const weeklyHolidayPay = eligible ? Math.round(hourlyPay * 0.2) : 0
  const total = hourlyPay + (includeHoliday ? weeklyHolidayPay : 0)
  return { hourlyPay, weeklyHolidayPay, total, eligible }
}

export type PayrollStatus = 'draft' | 'submitted' | 'confirmed' | 'paid'

export const STATUS_ORDER: PayrollStatus[] = ['draft', 'submitted', 'confirmed', 'paid']

export const STATUS_LABEL: Record<PayrollStatus, string> = {
  draft: '산정 중',
  submitted: '세무사 확정 대기',
  confirmed: '확정 (입금 대기)',
  paid: '지급 완료',
}

/** 여러 직원의 상태를 월 단위 하나로 요약한다 — 가장 덜 진행된 단계가 그 달의 상태. */
export function aggregateStatus(statuses: PayrollStatus[]): PayrollStatus {
  if (statuses.length === 0) return 'draft'
  return statuses.reduce<PayrollStatus>(
    (lowest, s) => (STATUS_ORDER.indexOf(s) < STATUS_ORDER.indexOf(lowest) ? s : lowest),
    'paid'
  )
}
