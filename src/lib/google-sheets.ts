import { google } from 'googleapis'

export type PaymentStatus = '입금완료' | '잔금처리요망' | '미입금'

export type SheetRow = {
  rowIndex: number       // 시트 내 행 번호 (1-based, 헤더 제외)
  date: string           // YYYY-MM-DD (B열)
  clientName: string     // 상호명 (C열)
  representative: string // 대표자 (D열)
  phone: string          // 전화번호 (E열)
  manager: string        // 담당자 (F열)
  amount: number         // 금액 (G열)
  memo: string           // 특이사항 (H열)
  status: PaymentStatus  // 입금상태 (I열)
}

/**
 * 시트 컬럼 구조: A(미사용) B=날짜 C=상호명 D=대표자 E=전화번호 F=담당자 G=금액 H=특이사항
 * 4월(2026-04-01) 이후 데이터만 반환
 */
export async function fetchSheetRows(fromDate = '2026-04-01'): Promise<SheetRow[]> {
  const credentialsRaw = process.env.GOOGLE_SHEETS_CREDENTIALS
  const sheetId = process.env.GOOGLE_SHEETS_ID
  const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME ?? 'Sheet1'

  if (!credentialsRaw || !sheetId) {
    throw new Error('GOOGLE_SHEETS_CREDENTIALS 또는 GOOGLE_SHEETS_ID 환경변수가 설정되지 않았습니다.')
  }

  const credentials = JSON.parse(credentialsRaw)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })

  const sheets = google.sheets({ version: 'v4', auth })
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!B2:I`,  // B열(날짜)부터 I열(입금상태)까지, 헤더 제외
  })

  const rows = response.data.values ?? []
  const cutoff = fromDate  // 이 날짜 이후만 동기화

  return rows
    .map((row, idx) => {
      // B=row[0], C=row[1], D=row[2], E=row[3], F=row[4], G=row[5], H=row[6]
      const rawDate = String(row[0] ?? '').trim()
      const rawAmount = String(row[5] ?? '').trim().replace(/,/g, '').replace(/[^\d.-]/g, '')
      const amount = parseFloat(rawAmount)

      if (!rawDate || isNaN(amount) || amount <= 0) return null

      const date = parseDate(rawDate)
      if (!date) return null

      // cutoff 이전 데이터는 건너뜀
      if (date < cutoff) return null

      const status = normalizeStatus(String(row[7] ?? '').trim())

      return {
        rowIndex: idx + 2,
        date,
        clientName: String(row[1] ?? '').trim(),
        representative: String(row[2] ?? '').trim(),
        phone: String(row[3] ?? '').trim(),
        manager: String(row[4] ?? '').trim(),
        amount,
        memo: String(row[6] ?? '').trim(),
        status,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null) as SheetRow[]
}

/** I열 드롭다운 값을 입금 상태로 정규화 */
function normalizeStatus(raw: string): PaymentStatus {
  if (/미입금/.test(raw)) return '미입금'
  if (/잔금/.test(raw)) return '잔금처리요망'
  if (/입금완료|완료|완납/.test(raw)) return '입금완료'
  return '입금완료'
}

function parseDate(raw: string): string | null {
  // YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = raw.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/)
  if (isoMatch) {
    const [, y, m, d] = isoMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  // MM/DD/YYYY or M/D/YYYY
  const usMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (usMatch) {
    const [, m, d, y] = usMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  // 한국어: 2026년 4월 1일
  const krMatch = raw.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)
  if (krMatch) {
    const [, y, m, d] = krMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return null
}

/**
 * external_id 생성: 날짜 + 상호명 + 금액 + 메모 + 담당자 기반 (행 번호 미사용)
 * 메모/담당자를 포함해 같은 날 동일 금액 중복 계약도 구분 가능
 */
export function makeExternalId(row: SheetRow): string {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-')
  const key = [
    row.date,
    normalize(row.clientName),
    String(row.amount),
    normalize(row.memo),
    normalize(row.manager),
  ].join('_')
  return `sheet_${key}`
}
