'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { CurrencyInput } from '@/components/ui/currency-input'
import { toast } from '@/lib/toast'
import { formatKRW } from '@/lib/calculations/settlement'
import { computeAutoIncentives, isLedgerIncentiveMonth } from '@/lib/calculations/incentives'
import { useMonth } from '@/components/shared/month-context'
import { MonthNavigator } from '@/components/shared/month-navigator'
import { StatementUpload } from '@/components/payroll/statement-upload'
import { paidStatus, transfersByEmployee, type PaidStatus, type PayTransfer } from '@/lib/payroll/paid'
import { clearAmounts, saveCashPay, setPaidCheck } from '@/lib/payroll/save-statement'
import { STATEMENT_KIND_LABEL, type StatementKind } from '@/lib/payroll/statement'
import { hiredBy, workedThrough } from '@/lib/payroll/tax'
import type { Employee, MonthlyPayroll } from '@/types/database'
import { AlertTriangle, Check, FileText, X } from 'lucide-react'

interface Row {
  emp: Employee
  kind: StatementKind | 'cash' | null
  file: string | null
  base: number
  incentive: number
  gross: number
  deduction: number
  net: number
  employerInsurance: number
  /** 명세서가 있는 직원만 지급 현황을 본다 */
  pay: PaidStatus | null
  checkedAt: string | null
}

const GRID = 'md:grid md:grid-cols-[1.4fr_1fr_1fr_1fr_1fr_1fr_1fr_1.5fr] md:gap-3'

/** 모바일에서만 라벨이 보이는 셀 — 데스크톱은 위쪽 헤더 행이 라벨 역할을 한다 */
function Cell({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center justify-between gap-2 md:block ${className}`}>
      <span className="text-xs text-gray-400 md:hidden shrink-0">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function toRow(emp: Employee, p: MonthlyPayroll | undefined, incentive: number, transfers: PayTransfer[]): Row {
  const base = Number(p?.base_salary ?? 0)
  const gross = base + incentive
  const deduction = Number(p?.base_income_tax ?? 0) + Number(p?.base_local_tax ?? 0)
    + Number(p?.incentive_income_tax ?? 0) + Number(p?.incentive_local_tax ?? 0) + Number(p?.other_deductions ?? 0)
  const net = gross - deduction
  const checkedAt = p?.paid_at ?? null
  return {
    emp, kind: p?.statement_kind ?? null, file: p?.statement_file ?? null,
    base, incentive, gross, deduction, net,
    employerInsurance: Number(p?.employer_insurance ?? 0),
    pay: p?.statement_kind ? paidStatus(net, transfers, checkedAt) : null,
    checkedAt,
  }
}

const transferDates = (pay: PaidStatus) => pay.transfers.map((t) => t.tx_date.slice(5).replace('-', '/')).join(', ')

/** 통장에서 찾은 이체로 판단하고, 못 찾는 지급만 사람이 체크한다 */
function PaidCell({ row, busy, onCheck }: { row: Row; busy: boolean; onCheck: (checked: boolean) => void }) {
  const { pay, checkedAt } = row
  if (!pay) return <span className="text-gray-300">-</span>
  if (pay.state === 'paid') return <span className="text-green-700">지급 완료 · {transferDates(pay)}</span>
  if (pay.state === 'over') {
    return (
      <span className="text-amber-700">
        {formatKRW(pay.paid)} 지급 ({transferDates(pay)})
        <span className="block text-xs">명세서보다 {formatKRW(pay.over)} 더 지급</span>
      </span>
    )
  }
  return (
    <span className="inline-flex flex-col md:items-end gap-0.5">
      {pay.paid > 0 && <span className="text-xs text-gray-500">{formatKRW(pay.paid)} 지급 ({transferDates(pay)})</span>}
      {pay.state === 'partial' && <span className="text-xs text-red-500">잔액 {formatKRW(pay.remaining)}</span>}
      <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
        <input type="checkbox" disabled={busy} checked={!!checkedAt} onChange={(e) => onCheck(e.target.checked)} />
        {checkedAt ? `지급 처리 ${checkedAt.slice(5).replace('-', '/')}` : '이미 지급'}
      </label>
    </span>
  )
}

/**
 * 급여 관리 — 세무사 명세서가 최종 금액이다. 앱에서 계산하거나 손으로 고치지 않는다.
 * 예외는 명세서에 없는 현금 지급뿐이며, 지급액을 그대로 비용으로 넣는다.
 * 고른 달은 귀속월이다. 10월을 고르면 11월에 지급하는 10월 귀속분을 다룬다.
 * 근무시간·결근·메모는 직원 관리에서 기록한다.
 */
export default function PayrollPage() {
  const supabase = createClient()
  const { year, month } = useMonth()
  const usesStatements = isLedgerIncentiveMonth(year, month)

  const [allEmployees, setAllEmployees] = useState<Employee[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [missing, setMissing] = useState<Employee[]>([])
  const [preHireRecords, setPreHireRecords] = useState<{ id: string; name: string; hired_at: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [cashEmployee, setCashEmployee] = useState('')
  const [cashAmount, setCashAmount] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const mm = String(month).padStart(2, '0')
    const start = `${year}-${mm}-01`
    const end = `${year}-${mm}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`

    const [
      { data: emps }, { data: payroll }, { data: manualIncentives }, { data: payments }, { data: settingsRows }, { data: cancelledProjects }, { data: bank },
    ] = await Promise.all([
      supabase.from('employees').select('*').order('sort_order', { nullsFirst: false }).order('name'),
      supabase.from('monthly_payroll').select('*').eq('year', year).eq('month', month),
      supabase.from('monthly_incentives').select('*').eq('year', year).eq('month', month),
      supabase.from('payments').select('amount, manager, status, excluded, project_id').gte('payment_date', start).lte('payment_date', end),
      supabase.from('settings').select('*'),
      supabase.from('projects').select('id').eq('status', 'cancelled'),
      // 귀속월 급여는 보통 다음 달에 나가지만 선지급·늦은 지급도 있어 앞뒤 한 달씩 더 본다
      supabase.from('bank_transactions').select('tx_date, counterparty, memo, withdrawal')
        .in('category', ['payroll_pay', 'incentive_pay']).eq('cancelled', false)
        .gte('tx_date', new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10))
        .lte('tx_date', new Date(Date.UTC(year, month + 2, 0)).toISOString().slice(0, 10)),
    ])
    const employees = emps ?? []
    setAllEmployees(employees)

    // 2026년 10월부터는 명세서 금액만 쓴다. 그전 달은 입금 실적 자동 인센티브를 그대로 보여준다
    const settings = Object.fromEntries((settingsRows ?? []).map((s) => [s.key, Number(s.value)]))
    const cancelledIds = new Set((cancelledProjects ?? []).map((p) => p.id))
    const confirmed = (payments ?? []).filter(
      (p) => p.status === 'confirmed' && !p.excluded && !(p.project_id && cancelledIds.has(p.project_id))
    )
    const incentive: Record<string, number> = {}
    for (const i of manualIncentives ?? []) {
      if (i.employee_id) incentive[i.employee_id] = (incentive[i.employee_id] ?? 0) + Number(i.amount)
    }
    const manualSet = new Set((manualIncentives ?? []).map((i) => i.employee_id))
    const savedIds = new Set((payroll ?? []).map((p) => p.employee_id))
    const targets = employees.filter((e) => hiredBy(e, end) && (workedThrough(e, start) || savedIds.has(e.id)))
    for (const auto of computeAutoIncentives(targets, confirmed, settings.vat_rate ?? 0.1, year, month, 'auto')) {
      if (!manualSet.has(auto.employee_id)) incentive[auto.employee_id] = auto.amount
    }

    const saved = new Map((payroll ?? []).map((p) => [p.employee_id ?? '', p]))
    const onStatement = employees.filter((e) => saved.get(e.id)?.statement_kind)
    const transfers = transfersByEmployee(onStatement, bank ?? [], year, month)
    const all = employees.map((e) => toRow(e, saved.get(e.id), incentive[e.id] ?? 0, transfers.get(e.id) ?? []))
    const paid = all.filter((r) => r.gross !== 0 || r.kind)
    setRows(paid.filter((r) => hiredBy(r.emp, end) || r.kind))
    const paidIds = new Set(paid.map((r) => r.emp.id))
    setMissing(employees.filter((e) => hiredBy(e, end) && workedThrough(e, start) && !paidIds.has(e.id)))

    // 입사일을 나중에 고치면 입사 전 달에 명세서 없이 저장된 기록이 남을 수 있다
    setPreHireRecords(paid.flatMap((r) => (hiredBy(r.emp, end) || r.kind ? [] : [{
      id: r.emp.id, name: r.emp.name, hired_at: r.emp.hired_at as string,
    }])))
    setLoading(false)
  }, [supabase, year, month])

  useEffect(() => { load() }, [load])

  const totals = useMemo(() => rows.reduce((t, r) => ({
    gross: t.gross + r.gross,
    deduction: t.deduction + r.deduction,
    net: t.net + r.net,
    insurance: t.insurance + r.employerInsurance,
    remaining: t.remaining + (r.pay?.remaining ?? 0),
  }), { gross: 0, deduction: 0, net: 0, insurance: 0, remaining: 0 }), [rows])

  const leftovers = usesStatements ? rows.filter((r) => !r.kind) : []
  const statements = (['business', 'insured'] as const).map((kind) => {
    const list = rows.filter((r) => r.kind === kind)
    return { kind, count: list.length, gross: list.reduce((s, r) => s + r.gross, 0), file: list[0]?.file ?? null }
  })

  async function clearRows(ids: string[], done: string) {
    setClearing(true)
    try {
      await clearAmounts(supabase, year, month, ids)
      toast.success(done)
      await load()
    } catch (e) {
      toast.error('정리 실패: ' + (e instanceof Error ? e.message : ''))
    } finally {
      setClearing(false)
    }
  }

  async function addCashPay() {
    const amount = Math.round(Number(cashAmount) || 0)
    if (!cashEmployee || amount <= 0) { toast.error('직원과 금액을 입력해 주세요.'); return }
    setClearing(true)
    try {
      await saveCashPay(supabase, year, month, cashEmployee, amount)
      toast.success('현금 지급을 반영했습니다.')
      setCashEmployee('')
      setCashAmount('')
      await load()
    } catch (e) {
      toast.error('저장 실패: ' + (e instanceof Error ? e.message : ''))
    } finally {
      setClearing(false)
    }
  }

  async function checkPaid(r: Row, checked: boolean) {
    setClearing(true)
    try {
      const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)
      await setPaidCheck(supabase, year, month, r.emp.id, checked ? today : null)
      await load()
    } catch (e) {
      toast.error('저장 실패: ' + (e instanceof Error ? e.message : ''))
    } finally {
      setClearing(false)
    }
  }

  const payMonth = month === 12 ? 1 : month + 1

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">급여 관리</h1>
          <p className="text-xs text-gray-400 mt-0.5">{month}월 귀속 · {payMonth}월 지급</p>
        </div>
        <MonthNavigator />
      </div>

      {usesStatements ? (
        <div className="space-y-2">
          <StatementUpload
            year={year} month={month}
            employees={allEmployees.map((e) => ({ id: e.id, name: e.name, active: e.active }))}
            saved={rows.filter((r) => r.kind).map((r) => ({ employeeId: r.emp.id, name: r.emp.name, kind: r.kind }))}
            onDone={load}
          />
          <div className="grid sm:grid-cols-2 gap-2">
            {statements.map((s) => (
              <div key={s.kind} className="flex items-start gap-2 rounded-lg border bg-white p-3 min-w-0">
                {s.count > 0
                  ? <Check size={15} className="text-green-600 mt-0.5 shrink-0" />
                  : <FileText size={15} className="text-gray-300 mt-0.5 shrink-0" />}
                <div className="min-w-0 text-sm">
                  <div className="font-medium">{STATEMENT_KIND_LABEL[s.kind]} 명세서</div>
                  <div className="text-xs text-gray-500 truncate">
                    {s.count > 0 ? `${s.count}명 · ${formatKRW(s.gross)} · ${s.file}` : '아직 올리지 않았습니다.'}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-white p-3">
            <span className="text-sm font-medium mr-auto">현금 지급 <span className="text-xs font-normal text-gray-400">명세서에 없는 직원 · 세금 없음</span></span>
            <select className="h-8 border rounded-md px-2 text-sm" aria-label="현금 지급 직원"
              value={cashEmployee} onChange={(e) => setCashEmployee(e.target.value)}>
              <option value="">직원 선택</option>
              {missing.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <CurrencyInput className="h-8 text-sm w-32" placeholder="지급액" aria-label="현금 지급액" value={cashAmount} onChange={setCashAmount} />
            <Button size="sm" variant="outline" disabled={clearing} onClick={addCashPay}>반영</Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-500 rounded-lg border bg-white p-3">
          2026년 9월까지는 저장된 금액을 조회만 할 수 있습니다. 명세서는 10월 귀속분부터 올립니다.
        </p>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-xs text-gray-500">지급액 (세전)</CardTitle></CardHeader>
          <CardContent><div className="text-lg font-bold">{formatKRW(totals.gross)}</div></CardContent>
        </Card>
        <Card className="border-red-100 bg-red-50/40">
          <CardHeader className="pb-1"><CardTitle className="text-xs text-red-500">공제 (세금·4대보험)</CardTitle></CardHeader>
          <CardContent><div className="text-lg font-bold text-red-700">− {formatKRW(totals.deduction)}</div></CardContent>
        </Card>
        <Card className="border-green-200 bg-green-50">
          <CardHeader className="pb-1"><CardTitle className="text-xs text-green-600">차인지급액 (입금액)</CardTitle></CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-green-800">{formatKRW(totals.net)}</div>
            {rows.some((r) => r.pay) && <p className="text-xs text-green-700/80 mt-0.5">남은 지급 {formatKRW(totals.remaining)}</p>}
          </CardContent>
        </Card>
        <Card className="border-purple-200 bg-purple-50/50">
          <CardHeader className="pb-1"><CardTitle className="text-xs text-purple-600">4대보험 회사부담</CardTitle></CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-purple-800">{formatKRW(totals.insurance)}</div>
            {totals.insurance === 0 && <p className="text-xs text-purple-600/70 mt-0.5">정산은 통장 납부액으로 추정</p>}
          </CardContent>
        </Card>
        <Card className="border-amber-200 bg-amber-50 col-span-2 lg:col-span-1">
          <CardHeader className="pb-1"><CardTitle className="text-xs text-amber-600">인건비 총원가</CardTitle></CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-amber-800">{formatKRW(totals.gross + totals.insurance)}</div>
            <p className="text-xs text-amber-600/70 mt-0.5">영업이익 차감 기준</p>
          </CardContent>
        </Card>
      </div>

      {leftovers.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 flex items-start gap-2">
          <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" />
          <div className="text-sm text-amber-900 space-y-1.5 min-w-0">
            <p className="font-medium">명세서 없이 입력된 금액이 {leftovers.length}명 있습니다.</p>
            <p className="text-xs leading-relaxed">
              {leftovers.map((r) => `${r.emp.name} ${formatKRW(r.gross)}`).join(', ')} — 그대로 두면 {month}월 정산에 들어갑니다.
              명세서를 올리면 해당 직원은 명세서 금액으로 바뀌고, 명세서에 없는 사람만 여기에 남습니다.
            </p>
            <Button size="sm" variant="outline" className="h-7 text-xs border-amber-400" disabled={clearing}
              onClick={() => clearRows(leftovers.map((r) => r.emp.id), `명세서 없는 금액 ${leftovers.length}명분을 지웠습니다.`)}>
              이 금액 지우기
            </Button>
          </div>
        </div>
      )}

      {usesStatements && missing.length > 0 && (
        <p className="text-sm text-gray-500 rounded-lg border bg-white p-3">
          <span className="font-medium text-gray-700">명세서에 없는 재직 직원 {missing.length}명:</span> {missing.map((e) => e.name).join(', ')}
        </p>
      )}

      {preHireRecords.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 flex items-start gap-2">
          <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" />
          <div className="text-sm text-amber-900 space-y-1.5 min-w-0">
            <p className="font-medium">입사 전인 직원의 급여 기록이 {month}월에 저장되어 있습니다.</p>
            <p className="text-xs leading-relaxed">
              {preHireRecords.map((r) => `${r.name}(입사 ${r.hired_at})`).join(', ')} — 이 기록은 {month}월 인건비·영업이익 집계에 포함됩니다.
            </p>
            <Button size="sm" variant="outline" className="h-7 text-xs border-amber-400" disabled={clearing}
              onClick={() => clearRows(preHireRecords.map((r) => r.id), `입사 전 급여 기록 ${preHireRecords.length}건을 지웠습니다.`)}>
              입사 전 급여 기록 지우기
            </Button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg border">
        <div className={`hidden ${GRID} px-4 py-2 border-b bg-gray-50 text-xs font-medium text-gray-500`}>
          <div>직원</div>
          <div className="text-right">기본급</div>
          <div className="text-right">인센티브</div>
          <div className="text-right">지급액 (세전)</div>
          <div className="text-right">공제</div>
          <div className="text-right">차인지급액</div>
          <div className="text-right">4대보험 회사부담</div>
          <div className="text-right">지급</div>
        </div>

        <div className="divide-y">
          {loading ? (
            <div className="py-10 text-center text-sm text-gray-400">불러오는 중...</div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-gray-400">
              {usesStatements ? `${month}월 귀속 명세서를 올리면 여기에 표시됩니다.` : '저장된 급여가 없습니다.'}
            </div>
          ) : rows.map((r) => (
            <div key={r.emp.id} className={`px-4 py-3 space-y-1.5 md:space-y-0 ${GRID} md:items-center text-sm`}>
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                <span className="font-medium text-gray-900">{r.emp.name}</span>
                {r.kind && <Badge variant="outline" className={`text-xs py-0 ${r.kind === 'insured' ? 'text-purple-600 border-purple-300' : 'text-gray-500'}`}>
                  {r.kind === 'insured' ? '4대보험' : r.kind === 'cash' ? '현금' : '3.3%'}
                </Badge>}
                {r.kind === 'cash' && (
                  <button type="button" aria-label={`${r.emp.name} 현금 지급 지우기`} disabled={clearing}
                    className="text-gray-300 hover:text-red-500"
                    onClick={() => clearRows([r.emp.id], `${r.emp.name} 현금 지급을 지웠습니다.`)}>
                    <X size={13} />
                  </button>
                )}
                {!r.emp.active && (
                  <Badge variant="outline" className="text-xs py-0 text-red-500 border-red-200">
                    퇴사{r.emp.terminated_at ? ` ${r.emp.terminated_at.slice(5)}` : ''}
                  </Badge>
                )}
              </div>
              <Cell label="기본급" className="md:text-right">{formatKRW(r.base)}</Cell>
              <Cell label="인센티브" className="md:text-right">
                {r.incentive !== 0 ? <span className="text-blue-600">{formatKRW(r.incentive)}</span> : <span className="text-gray-300">-</span>}
              </Cell>
              <Cell label="지급액 (세전)" className="md:text-right"><span className="font-semibold text-amber-700">{formatKRW(r.gross)}</span></Cell>
              <Cell label="공제" className="md:text-right"><span className="text-red-500">{formatKRW(r.deduction)}</span></Cell>
              <Cell label="차인지급액" className="md:text-right"><span className="font-bold text-green-700">{formatKRW(r.net)}</span></Cell>
              <Cell label="4대보험 회사부담" className="md:text-right">
                {r.employerInsurance > 0 ? <span className="text-purple-700">{formatKRW(r.employerInsurance)}</span> : <span className="text-gray-300">-</span>}
              </Cell>
              <Cell label="지급" className="md:text-right">
                <PaidCell row={r} busy={clearing} onCheck={(checked) => checkPaid(r, checked)} />
              </Cell>
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs text-gray-400 leading-relaxed">
        * 금액은 세무사 명세서 그대로입니다. 틀렸다면 세무사에게 수정본을 받아 다시 올리면 그 종류의 명세서 전체가 바뀝니다. 현금 지급은 명세서를 다시 올려도 유지됩니다.<br />
        * 영업이익에서 차감되는 인건비는 세전 지급액 + 4대보험 회사부담입니다.<br />
        * 지급 현황은 통장 업로드 후 이름과 메모(&quot;10월 급여&quot;)로 자동 확인합니다. 현금·묶음 이체처럼 통장에서 찾을 수 없는 지급만 체크하세요. 정산 금액에는 영향이 없습니다.<br />
        * 근무시간·결근·급여 조건·메모는 <Link href="/employees" className="underline">직원 관리</Link>에서 기록합니다.
      </p>
    </div>
  )
}
