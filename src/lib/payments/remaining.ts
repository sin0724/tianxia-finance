/**
 * 시트 행 하나(동기화 ID)에 묶인 결제들의 잔액 계산 — 순수 함수.
 *
 * 시트 행 = 결제 그룹: 원래 건(external_id = 동기화 ID)과 부분 입금 잔여분(`{동기화 ID}#xxxx`).
 * 잔액은 저장된 잔여분 금액이 아니라 "시트 금액(G) − 확정된 입금 합계"로 매번 다시 계산한다.
 * 그래야 확정 금액을 고쳐도 잔액이 따라 바뀐다.
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

/** 시트 금액 − 확정 입금 합계 (환불 등 음수 금액도 그대로 더한다) */
export function computeRemaining(
  sheetAmount: number,
  payments: { amount: number; status: string }[],
): number {
  const confirmed = payments
    .filter((p) => p.status === 'confirmed')
    .reduce((s, p) => s + Number(p.amount), 0)
  return sheetAmount - confirmed
}
