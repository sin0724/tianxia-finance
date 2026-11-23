/**
 * 결제시트 I열(입금상태) 셀 메모에 남기는 입금 기록 한 줄.
 *
 * 예전에는 부분 입금을 시트 메모("11/20 입금완료 1,980,000원")와 앱 입금 확정에 두 번 손으로 적어
 * 서로 어긋났다. 이제 앱의 입금 확정이 유일한 입력 지점이고, 메모 줄은 앱이 이 함수로 만들어 붙인다.
 * 입금 내역을 수정할 때 예전 줄을 찾아 바꾸므로 형식이 바뀌면 안 된다.
 */
export function formatDepositNoteLine(date: string /* YYYY-MM-DD */, amount: number): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(date)
  if (!m) throw new Error(`날짜 형식이 올바르지 않습니다: ${date}`)
  const month = Number(m[2])
  const day = Number(m[3])
  return `${month}/${day} 입금완료 ${amount.toLocaleString('ko-KR')}원`
}

/** 메모 끝에 한 줄 덧붙이기 — 기존 메모는 절대 지우지 않는다 */
export function appendNoteLine(existing: string, line: string): string {
  return existing ? `${existing}\n${line}` : line
}

/**
 * 메모에서 oldLine 과 정확히 같은 줄 하나를 newLine 으로 바꾼다. 없으면 맨 끝에 newLine 을 덧붙인다.
 * 줄 비교는 앞뒤 공백·\r 을 무시한다 (시트에서 손으로 고친 줄 끝 공백 때문에 못 찾는 일이 없게).
 */
export function replaceNoteLine(
  existing: string,
  oldLine: string,
  newLine: string,
): { note: string; result: 'replaced' | 'appended' } {
  if (existing) {
    const lines = existing.split('\n')
    const idx = lines.findIndex((l) => l.trim() === oldLine.trim())
    if (idx >= 0) {
      lines[idx] = newLine
      return { note: lines.join('\n'), result: 'replaced' }
    }
  }
  return { note: appendNoteLine(existing, newLine), result: 'appended' }
}

/**
 * 메모 줄 "M/D 입금완료 1,980,000원" 을 읽는다. 숫자 뒤가 "원"이거나 줄 끝일 때만 인정한다
 * ("8250만원" 같은 손글씨 형식은 금액을 확신할 수 없어 무시한다).
 */
const DEPOSIT_LINE_RE = /^(\d{1,2})\/(\d{1,2})\s*입금완료\s*([\d,]+)(?:\s*원|\s*$)/

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * 메모에서 amount 와 금액이 같은 입금 줄 중 마지막 줄을 찾아 그 입금일(YYYY-MM-DD)을 돌려준다.
 * 메모에는 연도가 없으므로 refDate(동기화한 날)의 연도를 쓰고, 그 날짜가 refDate 보다 뒤면 전년도로 본다.
 * 찾지 못하면 null. lineIndex 는 메모를 '\n' 으로 나눈 줄 번호.
 */
export function findDepositInNote(
  note: string,
  amount: number,
  refDate: string /* YYYY-MM-DD */,
): { date: string; lineIndex: number } | null {
  const ref = /^(\d{4})-(\d{2})-(\d{2})/.exec(refDate)
  if (!note || !ref) return null
  const refYear = Number(ref[1])
  const lines = note.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = DEPOSIT_LINE_RE.exec(lines[i].trim())
    if (!m) continue
    const digits = m[3].replace(/,/g, '')
    if (!digits || Number(digits) !== Math.round(amount)) continue
    const month = Number(m[1])
    const day = Number(m[2])
    if (month < 1 || month > 12 || day < 1) continue
    const year = `${pad2(month)}-${pad2(day)}` > refDate.slice(5, 10) ? refYear - 1 : refYear
    if (day > new Date(year, month, 0).getDate()) continue
    return { date: `${year}-${pad2(month)}-${pad2(day)}`, lineIndex: i }
  }
  return null
}
