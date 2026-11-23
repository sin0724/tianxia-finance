/**
 * 시트 행 하나(동기화 ID)에 묶인 결제들의 잔액 계산 — 순수 함수.
 *
 * 시트 행 = 결제 그룹: 원래 건(external_id = 동기화 ID)과 부분 입금 잔여분(`{동기화 ID}#xxxx`).
 * 잔액의 기준은 앱에 저장된 수금 예정(미확정) 금액이다 (pendingTotal).
 * 확정 금액을 고치면 그 차액만큼 수금 예정 금액을 조정한다 (adjustPendingByDelta).
 *
 * "시트 금액(G) − 확정 입금 합계"(computeRemaining)는 잔액을 정하는 데 쓰지 않는다 —
 * 여러 달 계약은 예전 입금이 다른 external_id(또는 없이)로 기록돼 그룹 밖에 있어서
 * 실제보다 큰 값이 나온다 (운영 dry-run 에서 확인).
 */

/** external_id 에서 시트 동기화 ID 부분만 — tx_ 형식이 아니면 null */
export function baseSyncId(externalId: string | null | undefined): string | null {
  if (!externalId || !externalId.startsWith('tx_')) return null
  const sep = externalId.indexOf('#')
  return sep >= 0 ? externalId.slice(0, sep) : externalId
}

/** 그룹에 속하는 external_id 인지 — 원래 건 또는 잔여분 */
export function isInSyncGroup(externalId: string | null | undefined, base: string): boolean {
  return externalId === base || (!!externalId && externalId.startsWith(`${base}#`))
}

/**
 * 시트 금액 − 확정 입금 합계 (환불 등 음수 금액도 그대로 더한다).
 *
 * 참고용(동기화의 읽기 전용 점검 로그)으로만 쓴다 — 예전 입금이 그룹 밖에 기록돼 있을 수 있어
 * 이 값으로 잔여분 금액이나 시트 입금상태를 바꾸면 안 된다.
 */
export function computeRemaining(
  sheetAmount: number,
  payments: { amount: number; status: string }[],
): number {
  const confirmed = payments
    .filter((p) => p.status === 'confirmed')
    .reduce((s, p) => s + Number(p.amount), 0)
  return sheetAmount - confirmed
}

/** 그룹의 수금 예정(미확정) 금액 합계 — 앱 기준 남은 잔액 */
export function pendingTotal(payments: { amount: number; status: string }[]): number {
  return payments
    .filter((p) => p.status !== 'confirmed')
    .reduce((s, p) => s + Number(p.amount), 0)
}

/**
 * 확정 금액이 delta(새 금액 − 예전 금액)만큼 바뀌었을 때 수금 예정 금액 조정.
 * 더 받았으면 줄이고 덜 받았으면 늘린다. 결과가 0 이하면 자동으로 고치지 않는다.
 */
export function adjustPendingByDelta(
  pendingAmount: number,
  delta: number,
): { ok: true; amount: number } | { ok: false } {
  const amount = pendingAmount - delta
  return amount > 0 ? { ok: true, amount } : { ok: false }
}
