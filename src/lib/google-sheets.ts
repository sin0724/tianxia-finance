import { google } from 'googleapis'
import type { sheets_v4 } from 'googleapis'

export type PaymentStatus = '입금완료' | '잔금처리요망' | '미입금' | '추가계약'

export type SheetRow = {
  rowIndex: number       // 시트 내 실제 행 번호 (1-based)
  syncId: string         // M열에 기록된 고유 동기화 ID — tx_ 형식일 때만 인정 (없으면 '')
  idCellOccupied: boolean // M열에 ID가 아닌 다른 내용이 있어 기록 불가
  date: string           // YYYY-MM-DD (B열)
  clientName: string     // 상호명 (C열)
  representative: string // 대표자 (D열)
  phone: string          // 전화번호 (E열)
  manager: string        // 담당자 (F열)
  amount: number         // 금액 (G열)
  memo: string           // 특이사항 (H열)
  status: PaymentStatus  // 입금상태 (I열)
}

/** 동기화 ID를 기록하는 열 — A(체크박스)·J(계산서)·K(메모)는 팀이 사용 중이라 여유를 두고 M열 사용 */
const SYNC_ID_COLUMN = 'M'
const SYNC_ID_HEADER = '동기화ID (수정금지)'

function getSheetsClient(readonly: boolean): { sheets: sheets_v4.Sheets; sheetId: string; sheetName: string } {
  const credentialsRaw = process.env.GOOGLE_SHEETS_CREDENTIALS
  const sheetId = process.env.GOOGLE_SHEETS_ID
  const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME ?? 'Sheet1'

  if (!credentialsRaw || !sheetId) {
    throw new Error('GOOGLE_SHEETS_CREDENTIALS 또는 GOOGLE_SHEETS_ID 환경변수가 설정되지 않았습니다.')
  }

  const credentials = JSON.parse(credentialsRaw)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [readonly
      ? 'https://www.googleapis.com/auth/spreadsheets.readonly'
      : 'https://www.googleapis.com/auth/spreadsheets'],
  })

  return { sheets: google.sheets({ version: 'v4', auth }), sheetId, sheetName }
}

/**
 * 시트 컬럼 구조: B=날짜 C=상호명 D=대표자 E=전화번호 F=담당자 G=금액 H=특이사항 I=입금상태 M=동기화ID(자동 기록)
 * A(체크박스)·J(계산서)·K(수기 메모)는 팀이 사용 중이므로 건드리지 않는다.
 * fromDate 이후 데이터만 반환. M열 ID는 앱이 write-back하며 사용자는 건드리지 않는다.
 */
export async function fetchSheetRows(fromDate = '2026-04-01'): Promise<SheetRow[]> {
  const { sheets, sheetId, sheetName } = getSheetsClient(true)

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!B2:${SYNC_ID_COLUMN}`,  // B열(날짜)부터 M열(동기화 ID)까지, 헤더 제외
  })

  const rows = response.data.values ?? []
  const cutoff = fromDate

  return rows
    .map((row, idx) => {
      // B=row[0], C=row[1], D=row[2], E=row[3], F=row[4], G=row[5], H=row[6], I=row[7], ..., M=row[11]
      const rawDate = String(row[0] ?? '').trim()
      const rawAmount = String(row[5] ?? '').trim().replace(/,/g, '').replace(/[^\d.-]/g, '')
      const amount = parseFloat(rawAmount)

      if (!rawDate || isNaN(amount) || amount <= 0) return null

      const date = parseDate(rawDate)
      if (!date) return null

      if (date < cutoff) return null

      const status = normalizeStatus(String(row[7] ?? '').trim())

      // ID 셀에 tx_ 형식이 아닌 값이 있으면 무시하고 덮어쓰지도 않는다 (사용자 데이터 보호)
      const rawIdCell = String(row[11] ?? '').trim()
      const isValidId = /^tx_/.test(rawIdCell)

      return {
        rowIndex: idx + 2,
        syncId: isValidId ? rawIdCell : '',
        idCellOccupied: !!rawIdCell && !isValidId,
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

/**
 * 동기화 ID를 시트 M열에 기록 (write-back).
 * 이후에는 상호명·금액·메모를 수정해도 같은 행으로 인식되어 중복 집계가 발생하지 않는다.
 * 서비스 계정에 시트 편집 권한이 필요하다. M열은 시트에서 숨김 처리해도 무방하다.
 */
export async function writeBackSyncIds(entries: { rowIndex: number; syncId: string }[]): Promise<void> {
  if (entries.length === 0) return
  const { sheets, sheetId, sheetName } = getSheetsClient(false)

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        // 헤더도 함께 유지 — 열의 용도를 시트에서 알 수 있게
        { range: `${sheetName}!${SYNC_ID_COLUMN}1`, values: [[SYNC_ID_HEADER]] },
        ...entries.map((e) => ({
          range: `${sheetName}!${SYNC_ID_COLUMN}${e.rowIndex}`,
          values: [[e.syncId]],
        })),
      ],
    },
  })
}

/** 새 동기화 ID 생성 — 행 내용과 무관한 불변 ID */
export function makeSyncId(): string {
  return `tx_${crypto.randomUUID()}`
}

/** I열 드롭다운 값을 입금 상태로 정규화 */
function normalizeStatus(raw: string): PaymentStatus {
  if (/미입금/.test(raw)) return '미입금'
  if (/잔금/.test(raw)) return '잔금처리요망'
  // '추가/재계약' — 진행 중인 업체라도 별도 계약 입금으로 처리 (새 프로젝트로 분리)
  if (/추가|재계약/.test(raw)) return '추가계약'
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
 * (레거시) 내용 기반 external_id — A열 ID가 없는 기존 데이터와의 매칭에만 사용.
 * 새 행에는 makeSyncId()로 생성한 불변 ID를 쓴다.
 */
export function makeLegacyExternalId(row: SheetRow): string {
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
