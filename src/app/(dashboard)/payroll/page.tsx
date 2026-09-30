'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { CurrencyInput } from '@/components/ui/currency-input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { toast } from '@/lib/toast'
import { formatKRW } from '@/lib/calculations/settlement'
import { useMonth } from '@/components/shared/month-context'
import { MonthNavigator } from '@/components/shared/month-navigator'
import { LedgerPasteDialog } from '@/components/payroll/ledger-paste-dialog'
import { buildBusinessIncomeLedger, downloadBlob, type LedgerEntry } from '@/lib/payroll/ledger'
import {
  withhold, calcPartTimePay, resolveSchedule, aggregateStatus,
  STATUS_LABEL, STATUS_ORDER, type PayrollStatus, type ResolvedSchedule,
} from '@/lib/payroll/tax'
import type { ParsedRow } from '@/lib/payroll/parse'
import type { Employee } from '@/types/database'
import {
  AlertTriangle, Calculator, Check, ClipboardPaste, Copy, Download, Pencil, Save, Sparkles, X,
} from 'lucide-react'

// ── 폼 상태 ────────────────────────────────────────────────────
type FormEntry = {
  work_hours: string
  absent_days: string
  include_weekly_holiday: boolean
  base_salary: string
  base_income_tax: string
  base_local_tax: string
  incentive_income_tax: string
  incentive_local_tax: string
  employer_insurance: string
  paid_at: string
  status: PayrollStatus
}

type StageKey = 'estimate' | 'confirm' | 'pay'

/** 금액용 — 원 단위로 반올림한다 */
const num = (v: string) => Math.round(Number(String(v).replace(/[^0-9.-]/g, '')) || 0)

/** 시간·일수용 — 8.5시간, 0.5일 같은 소수를 살린다 */
const numF = (v: string) => Number(String(v).replace(/[^0-9.-]/g, '')) || 0

/** 소수점 뒤 불필요한 0을 떼고 보여준다 */
const fmtHours = (h: number) => String(Math.round(h * 100) / 100)

function emptyForm(emp: Employee): FormEntry {
  return {
    work_hours: '0',
    absent_days: '0',
    include_weekly_holiday: true,
    base_salary: emp.employee_type === 'part_time' ? '0' : String(emp.base_salary ?? 0),
    base_income_tax: '0',
    base_local_tax: '0',
    incentive_income_tax: '0',
    incentive_local_tax: '0',
    employer_insurance: '0',
    paid_at: '',
    status: 'draft',
  }
}

const WEEK_DAYS_LABEL = (e: Employee) => {
  const days = e.work_days ? e.work_days.split(',').join('·') : ''
  const time = e.work_start_time && e.work_end_time ? `${e.work_start_time}~${e.work_end_time}` : ''
  const rest = e.break_minutes ? `휴게 ${e.break_minutes}분` : ''
  return [days, time, rest].filter(Boolean).join(' · ')
}

/** 입사일이 이 달 말일보다 뒤면 아직 입사 전이라 급여 대상이 아니다 (입사일 미입력은 대상으로 본다) */
const hiredBy = (e: Pick<Employee, 'hired_at'>, monthEnd: string) => !e.hired_at || e.hired_at <= monthEnd

/** 퇴사자는 퇴사일이 이 달 1일 이후면 그 달까지 급여 대상이다 — 마지막 달 급여를 빠뜨리지 않도록 */
const workedThrough = (e: Pick<Employee, 'active' | 'terminated_at'>, monthStart: string) =>
  e.active || (!!e.terminated_at && e.terminated_at >= monthStart)

/** 퇴사 배지 — 퇴사한 달의 급여는 일할 계산이 필요할 수 있어 눈에 띄게 표시한다 */
function RetiredBadge({ emp }: { emp: Employee }) {
  if (emp.active) return null
  return (
    <Badge variant="outline" className="text-xs py-0 text-red-500 border-red-200">
      퇴사{emp.terminated_at ? ` ${emp.terminated_at.slice(5)}` : ''}
    </Badge>
  )
}

/** 근무 일정이 등록된 알바의 이 달 소정근로 — 없으면 null */
const scheduleFor = (e: Employee, year: number, month: number): ResolvedSchedule | null =>
  e.employee_type === 'part_time'
    ? resolveSchedule(
        { days: e.work_days, start: e.work_start_time, end: e.work_end_time, breakMinutes: e.break_minutes ?? 0 },
        year, month
      )
    : null

/** 모바일에서만 라벨이 보이는 셀 — 데스크톱은 위쪽 헤더 행이 라벨 역할을 한다 */
function Cell({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center justify-between gap-2 md:block ${className}`}>
      <span className="text-xs text-gray-400 md:hidden shrink-0">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export default function PayrollPage() {
  const supabase = createClient()
  const { year, month } = useMonth()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [forms, setForms] = useState<Record<string, FormEntry>>({})
  const [incentiveGross, setIncentiveGross] = useState<Record<string, number>>({})
  const [manualIds, setManualIds] = useState<Set<string>>(new Set())
  const [existingIds, setExistingIds] = useState<Set<string>>(new Set())
  const [preHireRecords, setPreHireRecords] = useState<{ id: string; name: string; hired_at: string }[]>([])
  const [insuranceExpense, setInsuranceExpense] = useState<{ id: string; item_name: string | null; amount: number }[]>([])

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [tab, setTab] = useState<StageKey>('estimate')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [editingIncentive, setEditingIncentive] = useState<Record<string, string>>({})
  const [bulkPayDate, setBulkPayDate] = useState('')

  // ── 로드 ─────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true)
    const start = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    const [
      { data: emps },
      { data: payroll },
      { data: manualIncentives },
      { data: payments },
      { data: settingsRows },
      { data: cancelledProjects },
      { data: expenses },
    ] = await Promise.all([
      supabase.from('employees').select('*').order('sort_order', { nullsFirst: false }).order('name'),
      supabase.from('monthly_payroll').select('*').eq('year', year).eq('month', month),
      supabase.from('monthly_incentives').select('*').eq('year', year).eq('month', month),
      supabase.from('payments').select('amount, manager, status, excluded, project_id').gte('payment_date', start).lte('payment_date', end),
      supabase.from('settings').select('*'),
      supabase.from('projects').select('id').eq('status', 'cancelled'),
      supabase.from('monthly_expenses').select('id, item_name, amount').eq('year', year).eq('month', month),
    ])

    // 재직 기간에 걸친 달만 급여 대상이다 — 입사 전 달은 빼고, 퇴사자는 퇴사한 달까지 넣는다.
    // 이미 저장된 기록이 있는 퇴사자는 퇴사일이 비어 있어도 보여준다 (숨기면 집계에만 남는다).
    const savedIds = new Set((payroll ?? []).map((p) => p.employee_id))
    const empList = (emps ?? []).filter(
      (e) => hiredBy(e, end) && (workedThrough(e, start) || savedIds.has(e.id))
    )
    setEmployees(empList)

    // 입사일을 나중에 입력했거나 고친 경우, 입사 전 달에 이미 저장된 급여 기록이 남아 있을 수 있다
    const preHire = (emps ?? []).filter((e) => !hiredBy(e, end))
    setPreHireRecords(
      (payroll ?? []).flatMap((p) => {
        const e = preHire.find((x) => x.id === p.employee_id)
        return e ? [{ id: p.id, name: e.name, hired_at: e.hired_at as string }] : []
      })
    )

    // 4대보험 이중계상 감지 — 급여 화면에서 집계하므로 지출 항목에 또 있으면 안 된다
    setInsuranceExpense(
      (expenses ?? []).filter((e) => /4대보험|사대보험|사업주부담|회사부담/.test(e.item_name ?? '') && e.amount > 0)
    )

    // ── 인센티브: 수동 지정이 있으면 그 값, 없으면 입금 실적 기반 자동 산출 ──
    const settings = Object.fromEntries((settingsRows ?? []).map((s) => [s.key, Number(s.value)]))
    const vatRate = settings.vat_rate ?? 0.1
    const cancelledIds = new Set((cancelledProjects ?? []).map((p) => p.id))
    const confirmed = (payments ?? []).filter(
      (p) => p.status === 'confirmed' && !p.excluded && !(p.project_id && cancelledIds.has(p.project_id))
    )
    const manualSet = new Set((manualIncentives ?? []).map((i) => i.employee_id).filter(Boolean) as string[])
    setManualIds(manualSet)

    const gross: Record<string, number> = {}
    for (const i of manualIncentives ?? []) {
      if (i.employee_id) gross[i.employee_id] = (gross[i.employee_id] ?? 0) + i.amount
    }
    for (const emp of empList) {
      if (manualSet.has(emp.id)) continue
      if (!emp.incentive_type || emp.incentive_value <= 0) continue
      const mine = confirmed.filter((p) => p.manager?.trim().toLowerCase() === emp.name.trim().toLowerCase())
      if (mine.length === 0) continue
      const revenue = mine.reduce((s, p) => s + p.amount, 0)
      const supply = revenue / (1 + vatRate)
      gross[emp.id] = emp.incentive_type === 'percent'
        ? Math.round(supply * emp.incentive_value / 100)
        : emp.incentive_value
    }
    setIncentiveGross(gross)

    // ── 폼 채우기 ──────────────────────────────────────────────
    const saved = new Map((payroll ?? []).map((p) => [p.employee_id ?? '', p]))
    setExistingIds(new Set([...saved.keys()].filter(Boolean)))

    const next: Record<string, FormEntry> = {}
    for (const emp of empList) {
      const p = saved.get(emp.id)
      if (!p) { next[emp.id] = emptyForm(emp); continue }
      next[emp.id] = {
        work_hours: String(p.work_hours ?? 0),
        absent_days: String(p.absent_days ?? 0),
        include_weekly_holiday: p.include_weekly_holiday !== false,
        base_salary: String(p.base_salary ?? 0),
        base_income_tax: String(p.base_income_tax ?? 0),
        base_local_tax: String(p.base_local_tax ?? 0),
        incentive_income_tax: String(p.incentive_income_tax ?? 0),
        incentive_local_tax: String(p.incentive_local_tax ?? 0),
        employer_insurance: String(p.employer_insurance ?? 0),
        paid_at: p.paid_at ?? '',
        status: (p.status ?? 'draft') as PayrollStatus,
      }
    }
    setForms(next)
    setDirty(false)
    setLoading(false)
  }, [supabase, year, month])

  useEffect(() => { load() }, [load])

  // ── 파생 값 ──────────────────────────────────────────────────
  const rows = useMemo(() => employees.map((emp) => {
    const f = forms[emp.id] ?? emptyForm(emp)
    const isPartTime = emp.employee_type === 'part_time'
    const schedule = scheduleFor(emp, year, month)
    const partTime = calcPartTimePay({
      hours: numF(f.work_hours),
      hourlyWage: emp.hourly_wage ?? 0,
      absentDays: numF(f.absent_days),
      wageIncludesHoliday: emp.wage_includes_holiday ?? false,
      includeHoliday: f.include_weekly_holiday,
      schedule,
    })
    const base = isPartTime ? partTime.total : num(f.base_salary)
    // 인센티브는 세전액이 그대로 지급액에 들어간다. 3.3%는 ② 확정 단계의 세액 칸에서 뺀다.
    const incentive = incentiveGross[emp.id] ?? 0
    const gross = base + incentive

    const tax = num(f.base_income_tax) + num(f.base_local_tax) + num(f.incentive_income_tax) + num(f.incentive_local_tax)
    const suggested = { base: withhold(base), incentive: withhold(incentive) }
    const suggestedTax = suggested.base.totalTax + suggested.incentive.totalTax

    return {
      emp, form: f, isPartTime, partTime, schedule,
      base, incentive, gross,
      isManualIncentive: manualIds.has(emp.id),
      tax, net: gross - tax,
      employerInsurance: num(f.employer_insurance),
      suggested, suggestedTax,
      taxEntered: tax > 0,
      taxMatchesSuggestion: tax === suggestedTax,
    }
  }), [employees, forms, incentiveGross, manualIds, year, month])

  const totals = useMemo(() => rows.reduce((t, r) => ({
    base: t.base + r.base,
    incentive: t.incentive + r.incentive,
    gross: t.gross + r.gross,
    tax: t.tax + r.tax,
    net: t.net + r.net,
    insurance: t.insurance + r.employerInsurance,
  }), { base: 0, incentive: 0, gross: 0, tax: 0, net: 0, insurance: 0 }), [rows])

  const monthStatus = useMemo(
    () => aggregateStatus(rows.filter((r) => r.gross > 0).map((r) => r.form.status)),
    [rows]
  )

  // ── 폼 수정 ──────────────────────────────────────────────────
  function update(empId: string, patch: Partial<FormEntry>) {
    setForms((prev) => ({ ...prev, [empId]: { ...prev[empId], ...patch } }))
    setDirty(true)
  }

  // ── 저장 (전 직원 1회 요청) ──────────────────────────────────
  async function saveAll(statusOverride?: PayrollStatus, silent = false) {
    setSaving(true)
    const today = new Date().toISOString().slice(0, 10)
    const payload = rows.map((r) => {
      const f = r.form
      const baseTax = num(f.base_income_tax) + num(f.base_local_tax)
      const status = statusOverride ?? f.status
      return {
        year, month, employee_id: r.emp.id,
        base_salary: r.base,
        work_hours: numF(f.work_hours),
        absent_days: numF(f.absent_days),
        include_weekly_holiday: f.include_weekly_holiday,
        incentive_deductions: 0, // [DEPRECATED 017] 인센티브 3.3%는 incentive_*_tax로 이관
        base_income_tax: num(f.base_income_tax),
        base_local_tax: num(f.base_local_tax),
        incentive_income_tax: num(f.incentive_income_tax),
        incentive_local_tax: num(f.incentive_local_tax),
        employer_insurance: num(f.employer_insurance),
        // 파생 필드 — 기존 리포트/엑셀 호환 유지
        deductions: baseTax,
        net_pay: Math.max(0, r.base - baseTax),
        paid_at: f.paid_at || (status === 'paid' ? today : null),
        status,
        submitted_at: STATUS_ORDER.indexOf(status) >= 1 ? today : null,
        confirmed_at: STATUS_ORDER.indexOf(status) >= 2 ? today : null,
      }
    })

    const { error } = await supabase
      .from('monthly_payroll')
      .upsert(payload, { onConflict: 'year,month,employee_id' })
    setSaving(false)

    if (error) { toast.error('저장 실패: ' + error.message); return false }
    if (!silent) toast.success(`${month}월 급여가 저장되었습니다.`)
    await load()
    return true
  }

  // ── 인센티브 수동 조정 ───────────────────────────────────────
  async function saveIncentive(empId: string) {
    const amount = num(editingIncentive[empId] ?? '0')
    await supabase.from('monthly_incentives').delete().eq('year', year).eq('month', month).eq('employee_id', empId)
    if (amount > 0) {
      const { error } = await supabase.from('monthly_incentives')
        .insert({ year, month, employee_id: empId, amount, memo: '수동 조정' })
      if (error) { toast.error('저장 실패'); return }
    }
    toast.success(amount > 0 ? '인센티브를 수동 지정했습니다.' : '자동 계산으로 되돌렸습니다.')
    setEditingIncentive((prev) => { const n = { ...prev }; delete n[empId]; return n })
    await load()
  }

  // ── 지난달 불러오기 ─────────────────────────────────────────
  async function copyLastMonth() {
    const ly = month === 1 ? year - 1 : year
    const lm = month === 1 ? 12 : month - 1
    const { data } = await supabase.from('monthly_payroll')
      .select('employee_id, base_salary, work_hours, include_weekly_holiday, employer_insurance')
      .eq('year', ly).eq('month', lm)

    if (!data || data.length === 0) { toast.info(`${lm}월 급여 기록이 없습니다.`); return }
    const map = new Map(data.map((d) => [d.employee_id ?? '', d]))
    let applied = 0
    setForms((prev) => {
      const next = { ...prev }
      for (const emp of employees) {
        const src = map.get(emp.id)
        if (!src) continue
        next[emp.id] = {
          ...next[emp.id],
          base_salary: String(src.base_salary ?? 0),
          work_hours: String(src.work_hours ?? 0),
          include_weekly_holiday: src.include_weekly_holiday !== false,
          employer_insurance: String(src.employer_insurance ?? 0),
        }
        applied++
      }
      return next
    })
    setDirty(true)
    toast.success(`${lm}월 기준으로 ${applied}명을 채웠습니다. 확인 후 저장하세요.`)
  }

  // ── 근무시간 자동 산출 ──────────────────────────────────────
  // 하루 소정근로시간(휴게 제외) × (이 달 소정근로일수 − 결근일수).
  // 연장근무나 대타가 있으면 채운 뒤 직접 고치면 된다.
  function scheduledHours(schedule: ResolvedSchedule | null, absentDays: string): number | null {
    if (!schedule) return null
    const days = Math.max(0, schedule.monthlyDays - numF(absentDays))
    return Math.round(days * schedule.dailyHours * 100) / 100
  }

  function autoFillHours(empId: string) {
    const r = rows.find((x) => x.emp.id === empId)
    if (!r) return
    const hours = scheduledHours(r.schedule, r.form.absent_days)
    if (hours === null) return
    update(empId, { work_hours: String(hours) })
  }

  function autoFillAllHours() {
    const targets = rows.filter((r) => r.schedule !== null)
    if (targets.length === 0) {
      toast.info('근무 일정이 등록된 아르바이트가 없습니다. 직원 관리에서 요일·시간·휴게시간을 설정해주세요.')
      return
    }
    setForms((prev) => {
      const next = { ...prev }
      for (const r of targets) {
        const hours = scheduledHours(r.schedule, r.form.absent_days)
        if (hours !== null) next[r.emp.id] = { ...next[r.emp.id], work_hours: String(hours) }
      }
      return next
    })
    setDirty(true)
    toast.success(`${targets.length}명의 근무시간을 소정근로 기준으로 채웠습니다. 연장·대타가 있으면 직접 고쳐주세요.`)
  }

  // ── 3.3% 예상값 채우기 ──────────────────────────────────────
  function fillSuggestedTax() {
    setForms((prev) => {
      const next = { ...prev }
      for (const r of rows) {
        next[r.emp.id] = {
          ...next[r.emp.id],
          base_income_tax: String(r.suggested.base.incomeTax),
          base_local_tax: String(r.suggested.base.localTax),
          incentive_income_tax: String(r.suggested.incentive.incomeTax),
          incentive_local_tax: String(r.suggested.incentive.localTax),
        }
      }
      return next
    })
    setDirty(true)
    toast.info('3.3% 예상값으로 채웠습니다. 세무사 확정본과 대조해주세요.')
  }

  // ── 세무사 회신 반영 ────────────────────────────────────────
  function applyPaste(parsed: ParsedRow[]) {
    setForms((prev) => {
      const next = { ...prev }
      for (const p of parsed) {
        if (!p.employeeId || !next[p.employeeId]) continue
        next[p.employeeId] = {
          ...next[p.employeeId],
          base_income_tax: String(p.baseIncomeTax),
          base_local_tax: String(p.baseLocalTax),
          incentive_income_tax: String(p.incentiveIncomeTax),
          incentive_local_tax: String(p.incentiveLocalTax),
          ...(p.employerInsurance > 0 ? { employer_insurance: String(p.employerInsurance) } : {}),
        }
      }
      return next
    })
    setDirty(true)
    toast.success(`${parsed.length}명의 세액을 반영했습니다. 확인 후 저장하세요.`)
  }

  // ── 대장 내보내기 ───────────────────────────────────────────
  async function exportLedger() {
    const entries: LedgerEntry[] = rows
      .filter((r) => r.gross > 0)
      .map((r) => ({
        name: r.emp.name,
        base: r.base,
        // 확정 세액이 있으면 그것을, 없으면 3.3% 예상값을 넣는다
        baseIncomeTax: r.taxEntered ? num(r.form.base_income_tax) : r.suggested.base.incomeTax,
        baseLocalTax: r.taxEntered ? num(r.form.base_local_tax) : r.suggested.base.localTax,
        incentive: r.incentive,
        incentiveIncomeTax: r.taxEntered ? num(r.form.incentive_income_tax) : r.suggested.incentive.incomeTax,
        incentiveLocalTax: r.taxEntered ? num(r.form.incentive_local_tax) : r.suggested.incentive.localTax,
      }))

    if (entries.length === 0) { toast.error('지급액이 입력된 직원이 없습니다.'); return }

    setExporting(true)
    try {
      const { blob, filename } = await buildBusinessIncomeLedger(year, month, entries)
      downloadBlob(blob, filename)
      if (monthStatus === 'draft') await saveAll('submitted', true)
      toast.success('사업소득지급대장을 내려받았습니다.')
    } catch (e) {
      toast.error('생성 실패: ' + (e instanceof Error ? e.message : ''))
    } finally {
      setExporting(false)
    }
  }

  // ── 입사 전 달 급여 기록 정리 ───────────────────────────────
  async function clearPreHireRecords() {
    const ids = preHireRecords.map((r) => r.id)
    const { error } = await supabase.from('monthly_payroll').delete().in('id', ids)
    if (error) { toast.error('정리 실패: ' + error.message); return }
    toast.success(`${month}월에 잘못 잡힌 입사 전 급여 기록 ${ids.length}건을 삭제했습니다.`)
    await load()
  }

  // ── 4대보험 지출 항목 정리 ──────────────────────────────────
  async function clearInsuranceExpense() {
    const ids = insuranceExpense.map((e) => e.id)
    const { error } = await supabase.from('monthly_expenses').update({ amount: 0 }).in('id', ids)
    if (error) { toast.error('정리 실패: ' + error.message); return }
    toast.success('지출 항목을 0으로 정리했습니다. 이제 급여 화면 값만 반영됩니다.')
    await load()
  }

  function applyBulkPayDate() {
    if (!bulkPayDate) { toast.error('지급일을 선택해주세요.'); return }
    setForms((prev) => {
      const next = { ...prev }
      for (const r of rows) if (r.gross > 0) next[r.emp.id] = { ...next[r.emp.id], paid_at: bulkPayDate }
      return next
    })
    setDirty(true)
  }

  const insuranceTotalInExpense = insuranceExpense.reduce((s, e) => s + e.amount, 0)
  const showDoubleCountWarning = insuranceTotalInExpense > 0 && totals.insurance > 0

  // ── 렌더 ─────────────────────────────────────────────────────
  const GRID_ESTIMATE = 'md:grid md:grid-cols-[1.4fr_1.3fr_1.2fr_1.1fr_1.1fr] md:gap-3'
  const GRID_CONFIRM = 'md:grid md:grid-cols-[1.4fr_1.1fr_1.1fr_1.1fr_1.1fr_1fr] md:gap-3'
  const GRID_PAY = 'md:grid md:grid-cols-[1.4fr_1.2fr_1.2fr_1.4fr] md:gap-3'

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">급여 관리</h1>
          <Badge variant={monthStatus === 'paid' ? 'default' : 'secondary'} className="text-xs">
            {STATUS_LABEL[monthStatus]}
          </Badge>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <MonthNavigator />
          <Button size="sm" onClick={() => saveAll()} disabled={saving || !dirty}>
            <Save size={14} className="mr-1" />{saving ? '저장 중...' : '저장'}
          </Button>
        </div>
      </div>

      {/* 진행 단계 */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {STATUS_ORDER.map((s, i) => {
          const reached = STATUS_ORDER.indexOf(monthStatus) >= i
          return (
            <div key={s} className="flex items-center gap-1 shrink-0">
              <div className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                reached ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-400'
              }`}>
                {reached && <Check size={11} />}
                <span>{i + 1}. {STATUS_LABEL[s]}</span>
              </div>
              {i < STATUS_ORDER.length - 1 && <div className={`h-px w-4 ${reached ? 'bg-gray-900' : 'bg-gray-200'}`} />}
            </div>
          )
        })}
      </div>

      {/* 요약 */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-xs text-gray-500">지급액 (세전)</CardTitle></CardHeader>
          <CardContent><div className="text-lg font-bold">{formatKRW(totals.gross)}</div></CardContent>
        </Card>
        <Card className="border-red-100 bg-red-50/40">
          <CardHeader className="pb-1"><CardTitle className="text-xs text-red-500">원천징수 (3.3%)</CardTitle></CardHeader>
          <CardContent><div className="text-lg font-bold text-red-700">− {formatKRW(totals.tax)}</div></CardContent>
        </Card>
        <Card className="border-green-200 bg-green-50">
          <CardHeader className="pb-1"><CardTitle className="text-xs text-green-600">차인지급액 (입금액)</CardTitle></CardHeader>
          <CardContent><div className="text-lg font-bold text-green-800">{formatKRW(totals.net)}</div></CardContent>
        </Card>
        <Card className="border-purple-200 bg-purple-50/50">
          <CardHeader className="pb-1"><CardTitle className="text-xs text-purple-600">4대보험 회사부담</CardTitle></CardHeader>
          <CardContent><div className="text-lg font-bold text-purple-800">{formatKRW(totals.insurance)}</div></CardContent>
        </Card>
        <Card className="border-amber-200 bg-amber-50 col-span-2 lg:col-span-1">
          <CardHeader className="pb-1"><CardTitle className="text-xs text-amber-600">인건비 총원가</CardTitle></CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-amber-800">{formatKRW(totals.gross + totals.insurance)}</div>
            <p className="text-xs text-amber-600/70 mt-0.5">영업이익 차감 기준</p>
          </CardContent>
        </Card>
      </div>

      {/* 입사 전 달 급여 기록 경고 */}
      {preHireRecords.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" />
            <div className="text-sm text-amber-900 space-y-1.5 min-w-0">
              <p className="font-medium">입사 전인 직원의 급여 기록이 {month}월에 저장되어 있습니다.</p>
              <p className="text-xs leading-relaxed">
                {preHireRecords.map((r) => `${r.name}(입사 ${r.hired_at})`).join(', ')} — 이 기록은 화면에는 보이지 않지만
                {' '}{month}월 인건비·영업이익 집계에 포함됩니다.
              </p>
              <Button size="sm" variant="outline" className="h-7 text-xs border-amber-400" onClick={clearPreHireRecords}>
                입사 전 급여 기록 삭제
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 4대보험 이중계상 경고 */}
      {showDoubleCountWarning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" />
            <div className="text-sm text-amber-900 space-y-1.5 min-w-0">
              <p className="font-medium">4대보험이 두 번 계산되고 있습니다.</p>
              <p className="text-xs leading-relaxed">
                이 화면에서 집계된 회사부담분 <strong>{formatKRW(totals.insurance)}</strong>이 이미 영업이익에서 차감되는데,
                월별 지출에도 {insuranceExpense.map((e) => `"${e.item_name}"`).join(', ')} 항목으로{' '}
                <strong>{formatKRW(insuranceTotalInExpense)}</strong>이 들어가 있습니다.
              </p>
              <Button size="sm" variant="outline" className="h-7 text-xs border-amber-400" onClick={clearInsuranceExpense}>
                월별 지출 항목을 0으로 정리
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 단계별 작업 */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as StageKey)}>
        <TabsList>
          <TabsTrigger value="estimate">① 산정</TabsTrigger>
          <TabsTrigger value="confirm">② 세무사 확정</TabsTrigger>
          <TabsTrigger value="pay">③ 지급</TabsTrigger>
        </TabsList>

        {/* ─────────── ① 산정 ─────────── */}
        <TabsContent value="estimate">
          <div className="bg-white rounded-lg border">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b">
              <div>
                <h2 className="font-semibold text-gray-800">세전 지급액 산정</h2>
                <p className="text-xs text-gray-400 mt-0.5">우리가 정하는 값만 입력합니다. 세금은 다음 단계에서.</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {rows.some((r) => r.schedule !== null) && (
                  <Button size="sm" variant="outline" onClick={autoFillAllHours}>
                    <Calculator size={13} className="mr-1" />근무시간 자동 채우기
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={copyLastMonth}>
                  <Copy size={13} className="mr-1" />지난달 불러오기
                </Button>
                <Button size="sm" onClick={exportLedger} disabled={exporting}>
                  <Download size={13} className="mr-1" />
                  {exporting ? '생성 중...' : '사업소득지급대장 내보내기'}
                </Button>
              </div>
            </div>

            <div className={`hidden ${GRID_ESTIMATE} px-4 py-2 border-b bg-gray-50 text-xs font-medium text-gray-500`}>
              <div>직원</div>
              <div>근무시간 / 기본급</div>
              <div>인센티브 (세전)</div>
              <div className="text-right">지급액 (세전)</div>
              <div>4대보험 회사부담</div>
            </div>

            <div className="divide-y">
              {loading ? (
                <div className="py-10 text-center text-sm text-gray-400">불러오는 중...</div>
              ) : rows.length === 0 ? (
                <div className="py-10 text-center text-sm text-gray-400">
                  등록된 직원이 없습니다. 직원 관리에서 먼저 추가해주세요.
                </div>
              ) : rows.map((r) => (
                <div key={r.emp.id} className={`px-4 py-3 space-y-2 md:space-y-0 ${GRID_ESTIMATE} md:items-center ${
                  existingIds.has(r.emp.id) ? '' : 'bg-yellow-50/30'
                }`}>
                  {/* 직원 */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-gray-900">{r.emp.name}</span>
                      <RetiredBadge emp={r.emp} />
                      {r.isPartTime && (
                        <Badge variant="secondary" className="text-xs py-0">{formatKRW(r.emp.hourly_wage ?? 0)}/h</Badge>
                      )}
                      {r.isPartTime && r.emp.wage_includes_holiday && (
                        <Badge variant="outline" className="text-xs py-0 text-blue-600 border-blue-300">주휴 포함</Badge>
                      )}
                      {r.emp.insured && (
                        <Badge variant="outline" className="text-xs py-0 text-purple-600 border-purple-300">4대보험</Badge>
                      )}
                    </div>
                    {r.isPartTime && WEEK_DAYS_LABEL(r.emp) && (
                      <div className="text-xs text-gray-400 mt-0.5">{WEEK_DAYS_LABEL(r.emp)}</div>
                    )}
                    {r.schedule && (
                      <div className="text-xs text-gray-400">
                        1일 {fmtHours(r.schedule.dailyHours)}h · 이 달 소정 {r.schedule.monthlyDays}일 {fmtHours(r.schedule.monthlyHours)}h
                      </div>
                    )}
                    {r.schedule && r.schedule.breakShortfall > 0 && (
                      <div className="text-xs text-amber-600 mt-0.5">
                        휴게시간 {r.schedule.breakShortfall}분 부족 (근로기준법 제54조)
                      </div>
                    )}
                  </div>

                  {/* 근무시간 / 기본급 */}
                  <Cell label={r.isPartTime ? '근무시간' : '기본급'}>
                    {r.isPartTime ? (
                      <div className="space-y-1">
                        {/* 실근무시간 — 휴게시간과 결근을 뺀 시간 */}
                        <div className="flex items-center gap-1 justify-end md:justify-start">
                          <Input
                            type="number"
                            step="0.5"
                            min="0"
                            className="h-8 w-20 text-sm text-right"
                            value={r.form.work_hours}
                            onChange={(e) => update(r.emp.id, { work_hours: e.target.value })}
                          />
                          <span className="text-xs text-gray-400">h</span>
                          {r.schedule && (
                            <button
                              type="button"
                              onClick={() => autoFillHours(r.emp.id)}
                              title={`소정근로 기준으로 채우기 — 1일 ${fmtHours(r.schedule.dailyHours)}h × ${r.schedule.monthlyDays}일${
                                numF(r.form.absent_days) > 0 ? ` − 결근 ${fmtHours(numF(r.form.absent_days))}일` : ''
                              }`}
                              className="text-gray-300 hover:text-purple-600 transition-colors"
                            >
                              <Calculator size={14} />
                            </button>
                          )}
                        </div>

                        {/* 결근 — 시급분이 아니라 주휴 판정에만 쓴다 */}
                        <div className="flex items-center gap-1 justify-end md:justify-start">
                          <span className="text-xs text-gray-400">결근</span>
                          <Input
                            type="number"
                            step="0.5"
                            min="0"
                            className={`h-7 w-14 text-xs text-right ${
                              numF(r.form.absent_days) > 0 ? 'border-red-300 text-red-600' : ''
                            }`}
                            value={r.form.absent_days}
                            onChange={(e) => update(r.emp.id, { absent_days: e.target.value })}
                          />
                          <span className="text-xs text-gray-400">일</span>
                        </div>

                        {numF(r.form.work_hours) > 0 && (
                          <div className="text-xs text-right md:text-left space-y-0.5">
                            <div className="text-gray-500">시급분 {formatKRW(r.partTime.hourlyPay)}</div>

                            {r.emp.wage_includes_holiday ? (
                              <div className="text-blue-600">
                                주휴 포함 시급
                                {r.partTime.embeddedHolidayPay > 0 && (
                                  <span className="text-gray-400">
                                    {' '}· 주휴 상당 {formatKRW(r.partTime.embeddedHolidayPay)}
                                  </span>
                                )}
                              </div>
                            ) : !r.partTime.eligible ? (
                              <div className="text-gray-300">주휴 미해당 (주 15h 미만)</div>
                            ) : (
                              <label className="inline-flex items-center gap-1 cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={r.form.include_weekly_holiday}
                                  onChange={(e) => update(r.emp.id, { include_weekly_holiday: e.target.checked })}
                                  className="rounded"
                                />
                                <span className={r.form.include_weekly_holiday ? 'text-blue-600' : 'text-gray-400'}>
                                  주휴 {formatKRW(r.partTime.weeklyHolidayPay)}
                                </span>
                              </label>
                            )}

                            {r.partTime.forfeitedWeeks > 0 && (
                              r.emp.wage_includes_holiday ? (
                                <div className="text-gray-400">
                                  결근 {fmtHours(r.partTime.forfeitedWeeks)}주치 주휴 {formatKRW(r.partTime.forfeitedPay)}
                                  {' '}— 시급에 녹아 있어 자동 차감되지 않습니다
                                </div>
                              ) : (
                                <div className="text-red-500">
                                  결근 {fmtHours(r.partTime.forfeitedWeeks)}주치 주휴 소멸 − {formatKRW(r.partTime.forfeitedPay)}
                                </div>
                              )
                            )}

                            <div className="font-medium text-gray-700">= {formatKRW(r.partTime.total)}</div>

                            {r.partTime.basis === 'average' && r.partTime.eligible && (
                              <div className="text-gray-300">주휴는 월 평균으로 근사 — 근무 일정을 등록하면 정확해집니다</div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <CurrencyInput
                        className="h-8 text-sm w-32 md:w-full"
                        value={r.form.base_salary}
                        onChange={(v) => update(r.emp.id, { base_salary: v })}
                      />
                    )}
                  </Cell>

                  {/* 인센티브 (세전) */}
                  <Cell label="인센티브 (세전)">
                    {editingIncentive[r.emp.id] !== undefined ? (
                      <div className="flex items-center gap-1">
                        <CurrencyInput
                          className="h-8 text-sm w-28"
                          value={editingIncentive[r.emp.id]}
                          onChange={(v) => setEditingIncentive((p) => ({ ...p, [r.emp.id]: v }))}
                        />
                        <button onClick={() => saveIncentive(r.emp.id)} className="text-green-600 hover:text-green-800">
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => setEditingIncentive((p) => { const n = { ...p }; delete n[r.emp.id]; return n })}
                          className="text-gray-400 hover:text-gray-600"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <button
                        className="group flex items-center gap-1 justify-end md:justify-start w-full"
                        onClick={() => setEditingIncentive((p) => ({ ...p, [r.emp.id]: String(r.incentive) }))}
                        title="클릭해서 수동 지정 (0으로 저장하면 자동 계산 복원)"
                      >
                        {r.incentive > 0
                          ? <span className="text-blue-600 font-medium text-sm">{formatKRW(r.incentive)}</span>
                          : <span className="text-gray-300 text-sm">-</span>}
                        {r.isManualIncentive && <span className="text-xs text-orange-400">수동</span>}
                        <Pencil size={11} className="text-gray-300 opacity-0 group-hover:opacity-100" />
                      </button>
                    )}
                  </Cell>

                  {/* 지급액 세전 */}
                  <Cell label="지급액 (세전)" className="md:text-right">
                    <span className="font-semibold text-amber-700">{formatKRW(r.gross)}</span>
                  </Cell>

                  {/* 4대보험 */}
                  <Cell label="4대보험 회사부담">
                    {r.emp.insured ? (
                      <CurrencyInput
                        className="h-8 text-sm w-28 md:w-full"
                        placeholder="0"
                        value={r.form.employer_insurance}
                        onChange={(v) => update(r.emp.id, { employer_insurance: v })}
                      />
                    ) : (
                      <span className="text-xs text-gray-300">미가입</span>
                    )}
                  </Cell>
                </div>
              ))}
            </div>

            {rows.length > 0 && (
              <div className={`px-4 py-3 border-t bg-gray-50 font-semibold text-sm ${GRID_ESTIMATE} md:items-center`}>
                <div>합계</div>
                <div className="text-gray-600">{formatKRW(totals.base)}</div>
                <div className="text-blue-600">{formatKRW(totals.incentive)}</div>
                <div className="md:text-right text-amber-700">{formatKRW(totals.gross)}</div>
                <div className="text-purple-700">{formatKRW(totals.insurance)}</div>
              </div>
            )}
          </div>

          <p className="text-xs text-gray-400 mt-2 leading-relaxed">
            * 아르바이트 <strong>근무시간</strong>은 휴게시간과 결근을 뺀 실근무시간입니다. 근무 일정이 등록된 직원은 계산기 아이콘으로 소정근로 기준 시간을 채울 수 있습니다.<br />
            * <strong>결근</strong>은 시급분에서 다시 빼지 않습니다 (근무시간에 이미 반영). 그 주의 주휴수당이 발생하지 않는지만 가립니다 — 결근 1일당 1주치가 소멸합니다.
            연차·유급휴일은 결근이 아니므로 넣지 마세요.<br />
            * 인센티브는 이번 달 확정 입금 실적으로 자동 산출됩니다. 금액을 클릭하면 수동으로 덮어쓸 수 있고, 0으로 저장하면 자동 계산으로 돌아갑니다.<br />
            * 여기 넣는 금액은 모두 <strong>세전</strong>입니다. 인센티브 3.3% 원천징수는 ② 확정 단계에서 소득세·지방소득세로 나눠 기록합니다.<br />
            * 대장을 내보내면 자동으로 <strong>세무사 확정 대기</strong> 상태로 넘어갑니다.
          </p>
        </TabsContent>

        {/* ─────────── ② 확정 ─────────── */}
        <TabsContent value="confirm">
          <div className="bg-white rounded-lg border">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b">
              <div>
                <h2 className="font-semibold text-gray-800">세무사 확정본 입력</h2>
                <p className="text-xs text-gray-400 mt-0.5">회신받은 급여장부의 세액을 그대로 받아 적습니다.</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button size="sm" variant="outline" onClick={fillSuggestedTax}>
                  <Sparkles size={13} className="mr-1" />3.3% 예상값 채우기
                </Button>
                <Button size="sm" onClick={() => setPasteOpen(true)}>
                  <ClipboardPaste size={13} className="mr-1" />급여장부 붙여넣기
                </Button>
              </div>
            </div>

            <div className={`hidden ${GRID_CONFIRM} px-4 py-2 border-b bg-gray-50 text-xs font-medium text-gray-500`}>
              <div>직원</div>
              <div className="text-right">지급액 (세전)</div>
              <div>소득세</div>
              <div>지방소득세</div>
              <div className="text-right">차인지급액</div>
              <div className="text-center">검산</div>
            </div>

            <div className="divide-y">
              {rows.filter((r) => r.gross > 0).length === 0 ? (
                <div className="py-10 text-center text-sm text-gray-400">
                  ① 산정 단계에서 지급액을 먼저 입력해주세요.
                </div>
              ) : rows.filter((r) => r.gross > 0).map((r) => (
                <div key={r.emp.id} className={`px-4 py-3 space-y-2 md:space-y-0 ${GRID_CONFIRM} md:items-center`}>
                  <div className="min-w-0">
                    <span className="font-medium text-gray-900">{r.emp.name}</span>
                    <RetiredBadge emp={r.emp} />
                    {r.incentive > 0 && (
                      <div className="text-xs text-gray-400 mt-0.5">기본급 + 인센티브 (2줄)</div>
                    )}
                  </div>

                  <Cell label="지급액 (세전)" className="md:text-right">
                    <div className="text-sm">
                      <div className="font-medium text-amber-700">{formatKRW(r.gross)}</div>
                      {r.incentive > 0 && (
                        <div className="text-xs text-gray-400">
                          {formatKRW(r.base)} + {formatKRW(r.incentive)}
                        </div>
                      )}
                    </div>
                  </Cell>

                  <Cell label="소득세">
                    <div className="space-y-1">
                      <CurrencyInput
                        className="h-8 text-sm w-28 md:w-full"
                        value={r.form.base_income_tax}
                        onChange={(v) => update(r.emp.id, { base_income_tax: v })}
                      />
                      {r.incentive > 0 && (
                        <CurrencyInput
                          className="h-8 text-sm w-28 md:w-full border-blue-200"
                          value={r.form.incentive_income_tax}
                          onChange={(v) => update(r.emp.id, { incentive_income_tax: v })}
                        />
                      )}
                    </div>
                  </Cell>

                  <Cell label="지방소득세">
                    <div className="space-y-1">
                      <CurrencyInput
                        className="h-8 text-sm w-28 md:w-full"
                        value={r.form.base_local_tax}
                        onChange={(v) => update(r.emp.id, { base_local_tax: v })}
                      />
                      {r.incentive > 0 && (
                        <CurrencyInput
                          className="h-8 text-sm w-28 md:w-full border-blue-200"
                          value={r.form.incentive_local_tax}
                          onChange={(v) => update(r.emp.id, { incentive_local_tax: v })}
                        />
                      )}
                    </div>
                  </Cell>

                  <Cell label="차인지급액" className="md:text-right">
                    <span className="font-bold text-green-700">{formatKRW(r.net)}</span>
                  </Cell>

                  <Cell label="검산" className="md:text-center">
                    {!r.taxEntered ? (
                      <span className="text-xs text-gray-300">미입력</span>
                    ) : r.taxMatchesSuggestion ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-600">
                        <Check size={12} />3.3% 일치
                      </span>
                    ) : (
                      <span className="text-xs text-amber-600" title={`3.3% 예상 세액 ${formatKRW(r.suggestedTax)}`}>
                        {r.tax > r.suggestedTax ? '+' : ''}{formatKRW(r.tax - r.suggestedTax)}
                      </span>
                    )}
                  </Cell>
                </div>
              ))}
            </div>

            {rows.some((r) => r.gross > 0) && (
              <>
                <div className={`px-4 py-3 border-t bg-gray-50 font-semibold text-sm ${GRID_CONFIRM} md:items-center`}>
                  <div>합계</div>
                  <div className="md:text-right text-amber-700">{formatKRW(totals.gross)}</div>
                  <div className="text-red-500 md:col-span-2">− {formatKRW(totals.tax)}</div>
                  <div className="md:text-right text-green-700">{formatKRW(totals.net)}</div>
                  <div />
                </div>
                <div className="px-4 py-3 border-t flex justify-end">
                  <Button
                    size="sm"
                    onClick={async () => { if (await saveAll('confirmed')) setTab('pay') }}
                    disabled={saving || totals.tax === 0}
                  >
                    확정하고 지급 단계로 →
                  </Button>
                </div>
              </>
            )}
          </div>

          <p className="text-xs text-gray-400 mt-2 leading-relaxed">
            * 인센티브가 있는 직원은 대장과 같이 <strong>윗칸 기본급분 / 아랫칸(파란 테두리) 인센티브분</strong>으로 나눠 입력합니다.
            인센티브 3.3%는 여기 아랫칸에 들어갑니다.<br />
            * 검산 칸은 3.3% 계산과의 차액입니다. 4대보험 가입자나 연말정산 반영이 있으면 차이가 날 수 있으니 세무사 값을 그대로 두세요.
          </p>
        </TabsContent>

        {/* ─────────── ③ 지급 ─────────── */}
        <TabsContent value="pay">
          <div className="bg-white rounded-lg border">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b">
              <div>
                <h2 className="font-semibold text-gray-800">입금 처리</h2>
                <p className="text-xs text-gray-400 mt-0.5">차인지급액을 입금하고 지급일을 남깁니다.</p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="date"
                  className="h-8 text-sm w-36"
                  value={bulkPayDate}
                  onChange={(e) => setBulkPayDate(e.target.value)}
                />
                <Button size="sm" variant="outline" onClick={applyBulkPayDate}>일괄 지정</Button>
              </div>
            </div>

            <div className={`hidden ${GRID_PAY} px-4 py-2 border-b bg-gray-50 text-xs font-medium text-gray-500`}>
              <div>직원</div>
              <div className="text-right">차인지급액 (입금액)</div>
              <div className="text-right">4대보험 회사부담</div>
              <div>지급일</div>
            </div>

            <div className="divide-y">
              {rows.filter((r) => r.gross > 0).length === 0 ? (
                <div className="py-10 text-center text-sm text-gray-400">지급할 급여가 없습니다.</div>
              ) : rows.filter((r) => r.gross > 0).map((r) => (
                <div key={r.emp.id} className={`px-4 py-3 space-y-2 md:space-y-0 ${GRID_PAY} md:items-center`}>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-gray-900">{r.emp.name}</span>
                    <RetiredBadge emp={r.emp} />
                    {r.form.status === 'paid' && <Check size={13} className="text-green-500" />}
                  </div>
                  <Cell label="차인지급액" className="md:text-right">
                    <span className="font-bold text-green-700">{formatKRW(r.net)}</span>
                  </Cell>
                  <Cell label="4대보험 회사부담" className="md:text-right">
                    <span className="text-sm text-purple-700">
                      {r.employerInsurance > 0 ? formatKRW(r.employerInsurance) : '-'}
                    </span>
                  </Cell>
                  <Cell label="지급일">
                    <Input
                      type="date"
                      className="h-8 text-sm w-36"
                      value={r.form.paid_at}
                      onChange={(e) => update(r.emp.id, { paid_at: e.target.value })}
                    />
                  </Cell>
                </div>
              ))}
            </div>

            {rows.some((r) => r.gross > 0) && (
              <>
                <div className={`px-4 py-3 border-t bg-gray-50 font-semibold text-sm ${GRID_PAY} md:items-center`}>
                  <div>합계</div>
                  <div className="md:text-right text-green-700">{formatKRW(totals.net)}</div>
                  <div className="md:text-right text-purple-700">{formatKRW(totals.insurance)}</div>
                  <div />
                </div>
                <div className="px-4 py-3 border-t flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-gray-500">
                    실제 통장에서 나가는 금액: <strong>{formatKRW(totals.net + totals.tax + totals.insurance)}</strong>
                    <span className="text-gray-400"> (차인지급액 + 원천징수 납부 + 4대보험)</span>
                  </p>
                  <Button size="sm" onClick={() => saveAll('paid')} disabled={saving || monthStatus === 'paid'}>
                    <Check size={14} className="mr-1" />
                    {monthStatus === 'paid' ? '지급 완료됨' : '지급 완료 처리'}
                  </Button>
                </div>
              </>
            )}
          </div>

          <p className="text-xs text-gray-400 mt-2 leading-relaxed">
            * 영업이익에서 차감되는 인건비는 <strong>세전 지급액 + 4대보험 회사부담 = {formatKRW(totals.gross + totals.insurance)}</strong>입니다.
            원천징수세는 직원이 부담하지만 회사가 대신 납부하므로 비용은 세전 기준으로 잡습니다.
          </p>
        </TabsContent>
      </Tabs>

      <LedgerPasteDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        employees={employees.map((e) => ({ id: e.id, name: e.name }))}
        onApply={applyPaste}
      />
    </div>
  )
}
