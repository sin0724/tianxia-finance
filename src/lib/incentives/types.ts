/** 인센티브 정산 API가 화면에 돌려주는 모양 */
import type { IncentiveClawback, IncentiveLine, IncentiveManager, IncentiveMonth } from '@/types/database'
import type { IncentiveConfig, LineKind } from './engine'

/** 계약(동기화ID) 하나의 정산 누계 — 모든 달 + 앱으로 옮기기 전 정산시트 */
export interface ContractInfo {
  settled: number
  paidCount: number
  originYear: number | null
  originMonth: number | null
  /** 원래 줄이 정산시트(앱 도입 전 달)에 있다 */
  fromSheet: boolean
}

export interface CheckItem {
  lineId: string
  managerId: string
  year: number
  month: number
  clientName: string
  note: string
}

export interface MonthView {
  year: number
  month: number
  config: IncentiveConfig
  managers: IncentiveManager[]
  months: IncentiveMonth[]
  lines: IncentiveLine[]
  clawbacks: IncentiveClawback[]
  /** 지난달 수동 줄 — 이 달로 가져오기 후보 */
  prevManual: IncentiveLine[]
  latest: Record<string, { year: number; month: number }>
  contracts: Record<string, ContractInfo>
  /** [이 달 확인] 메모 */
  checks: CheckItem[]
  /** 정산시트에서 정산한 마지막 달 (이월 데이터 기준) — 이 달까지는 앱 정산표를 만들지 않는다 */
  sheetUntil: { year: number; month: number } | null
}

export interface FinanceEntry {
  id: string
  date: string
  amount: number
  status: 'confirmed' | 'balance_due' | 'unpaid'
  manager: string | null
  client: string | null
  externalId: string | null
  projectName: string | null
  projectStatus: string | null
  memo: string | null
}

export interface FinanceView {
  bySid: Record<string, { monthIn: number; monthRefund: number; toDate: number; pending: number; entries: FinanceEntry[] }>
  unmatched: (FinanceEntry & { managerId: string })[]
  refunds: (FinanceEntry & { managerId: string })[]
}

export interface CrmView {
  bySid: Record<string, { name: string; owner: string; date: string; amount: number; status: string; memo: string }>
  /** 지금 동기화하면 생길 줄 */
  preview: Record<string, {
    add: { client_name: string; kind: LineKind; sales: number; paid: number | null; note: string; date: string }[]
    originUpdates: number
    latest: boolean
  }>
  missingSid: { row: number; date: string; name: string; owner: string; amount: number }[]
  /** 이 달 CRM 줄 중 담당자 값이 설정의 CRM 담당자명에 없어 동기화에서 빠지는 줄 — 이름이 담당자와 같은 것만 */
  unmapped: { row: number; owner: string; managerId: string; date: string; name: string; amount: number }[]
}

export interface ViewResponse {
  view: MonthView
  finance: FinanceView | null
  financeError: string | null
}

export interface CrmResponse {
  crm: CrmView | null
  crmError: string | null
}
