'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from 'sonner'
import { formatKRW } from '@/lib/calculations/settlement'
import { Download, ChevronLeft, ChevronRight, Pencil, Check, X } from 'lucide-react'

type PayrollRow = {
  employee_id: string
  name: string
  base_salary: number
  incentive: number
  isManualIncentive: boolean
  deductions: number
  incentive_deductions: number
  net_pay: number
  total_pay: number
  paid_at: string | null
}

interface IncentiveCellProps {
  row: PayrollRow
  editingValue: string | undefined
  isSaving: boolean
  onStartEdit: (empId: string, value: number) => void
  onCancelEdit: (empId: string) => void
  onSave: (empId: string) => void
  onChangeValue: (empId: string, value: string) => void
}

function IncentiveCell({ row, editingValue, isSaving, onStartEdit, onCancelEdit, onSave, onChangeValue }: IncentiveCellProps) {
  const empId = row.employee_id

  if (editingValue !== undefined) {
    return (
      <div className="flex items-center justify-end gap-1">
        <input
          type="text"
          value={editingValue}
          onChange={(e) => onChangeValue(empId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave(empId)
            if (e.key === 'Escape') onCancelEdit(empId)
          }}
          className="w-28 text-right border border-blue-300 rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          autoFocus
          disabled={isSaving}
        />
        <button
          onClick={() => onSave(empId)}
          disabled={isSaving}
          className="text-green-600 hover:text-green-800 disabled:opacity-50"
        >
          <Check size={14} />
        </button>
        <button
          onClick={() => onCancelEdit(empId)}
          disabled={isSaving}
          className="text-gray-400 hover:text-gray-600"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <div
      className="flex items-center justify-end gap-1 group cursor-pointer"
      onClick={() => onStartEdit(empId, row.incentive)}
      title="클릭하여 수동 조정 (0 입력 시 자동 계산으로 복원)"
    >
      <div className="flex flex-col items-end">
        {row.incentive > 0
          ? <span className="text-blue-600 font-medium">{formatKRW(row.incentive)}</span>
          : <span className="text-gray-300">-</span>}
        {row.isManualIncentive && (
          <span className="text-xs text-orange-400 leading-none">수동</span>
        )}
      </div>
      <Pencil size={11} className="text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
    </div>
  )
}

export default function PayrollPage() {
  const supabase = createClient()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [rows, setRows] = useState<PayrollRow[]>([])
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [editingIncentive, setEditingIncentive] = useState<Record<string, string>>({})
  const [savingIncentive, setSavingIncentive] = useState<Set<string>>(new Set())

  useEffect(() => { load() }, [year, month])

  async function load() {
    setLoading(true)

    const start = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    const [
      { data: payroll },
      { data: employees },
      { data: manualIncentives },
      { data: payments },
      { data: settingsRows },
      { data: cancelledProjects },
    ] = await Promise.all([
      supabase.from('monthly_payroll').select('*, employees(name)').eq('year', year).eq('month', month),
      supabase.from('employees').select('id, name, incentive_type, incentive_value').eq('active', true),
      supabase.from('monthly_incentives').select('*').eq('year', year).eq('month', month),
      supabase.from('payments').select('amount, manager, memo, project_id')
        .gte('payment_date', start).lte('payment_date', end),
      supabase.from('settings').select('*'),
      supabase.from('projects').select('id').eq('status', 'cancelled'),
    ])

    const settings = Object.fromEntries((settingsRows ?? []).map((s) => [s.key, Number(s.value)]))
    const vatRate = settings.vat_rate ?? 0.1

    // 정산 API(calculate-settlement)와 동일한 제외 기준 적용
    const isPending = (memo: string | null) =>
      !!(memo?.includes('⚠ 잔금 처리 요망') || memo?.includes('🔴 미입금'))
    const isExcluded = (memo: string | null) => !!(memo?.includes('🚫 집계 제외'))
    const cancelledIds = new Set((cancelledProjects ?? []).map((p) => p.id))
    const confirmedPayments = (payments ?? []).filter(
      (p) => !isPending(p.memo) && !isExcluded(p.memo) && !(p.project_id && cancelledIds.has(p.project_id))
    )

    const manualEmployeeIds = new Set((manualIncentives ?? []).map((i) => i.employee_id))

    const autoIncentiveMap: Record<string, number> = {}
    for (const emp of employees ?? []) {
      if (!emp.incentive_type || emp.incentive_value <= 0) continue
      if (manualEmployeeIds.has(emp.id)) continue

      const myPayments = confirmedPayments.filter(
        (p) => p.manager?.trim().toLowerCase() === emp.name.trim().toLowerCase()
      )
      if (myPayments.length === 0) continue

      const myRevenue = myPayments.reduce((s, p) => s + p.amount, 0)
      const mySupplyValue = myRevenue / (1 + vatRate)
      autoIncentiveMap[emp.id] = emp.incentive_type === 'percent'
        ? Math.round(mySupplyValue * emp.incentive_value / 100)
        : emp.incentive_value
    }

    const manualIncentiveMap: Record<string, number> = {}
    for (const i of manualIncentives ?? []) {
      if (i.employee_id) manualIncentiveMap[i.employee_id] = (manualIncentiveMap[i.employee_id] ?? 0) + i.amount
    }

    const result: PayrollRow[] = (payroll ?? []).map((p) => {
      const emp = p as typeof p & { employees: { name: string } | null }
      const empId = p.employee_id ?? ''
      const isManual = manualEmployeeIds.has(empId)
      const incentive = manualIncentiveMap[empId] ?? autoIncentiveMap[empId] ?? 0
      const incentiveDed = (p as typeof p & { incentive_deductions?: number }).incentive_deductions ?? 0
      const netIncentive = Math.max(0, incentive - incentiveDed)
      return {
        employee_id: empId,
        name: emp.employees?.name ?? '-',
        base_salary: p.base_salary,
        incentive,
        isManualIncentive: isManual,
        deductions: p.deductions,
        incentive_deductions: incentiveDed,
        net_pay: p.net_pay,
        total_pay: p.net_pay + netIncentive,
        paid_at: p.paid_at,
      }
    })

    setRows(result)
    setLoading(false)
  }

  function startEdit(empId: string, currentValue: number) {
    setEditingIncentive((prev) => ({ ...prev, [empId]: String(currentValue) }))
  }

  function cancelEdit(empId: string) {
    setEditingIncentive((prev) => {
      const next = { ...prev }
      delete next[empId]
      return next
    })
  }

  function changeValue(empId: string, value: string) {
    setEditingIncentive((prev) => ({ ...prev, [empId]: value }))
  }

  async function saveIncentive(empId: string) {
    const rawValue = editingIncentive[empId] ?? '0'
    const amount = Number(rawValue.replace(/[^0-9]/g, '')) || 0

    setSavingIncentive((prev) => new Set([...prev, empId]))
    try {
      // 기존 수동 인센티브 삭제 후 재삽입 (0이면 자동 계산 복원)
      await supabase.from('monthly_incentives')
        .delete()
        .eq('year', year)
        .eq('month', month)
        .eq('employee_id', empId)

      if (amount > 0) {
        await supabase.from('monthly_incentives').insert({
          year,
          month,
          employee_id: empId,
          amount,
          memo: '수동 조정',
        })
      }

      toast.success(amount > 0 ? '인센티브가 저장되었습니다' : '자동 계산으로 복원되었습니다')
      cancelEdit(empId)
      await load()
    } catch {
      toast.error('저장 실패')
    } finally {
      setSavingIncentive((prev) => {
        const next = new Set(prev)
        next.delete(empId)
        return next
      })
    }
  }

  const totalBase           = rows.reduce((s, r) => s + r.base_salary, 0)
  const totalIncentive      = rows.reduce((s, r) => s + r.incentive, 0)
  const totalIncentiveDed   = rows.reduce((s, r) => s + r.incentive_deductions, 0)
  const totalDeduct         = rows.reduce((s, r) => s + r.deductions, 0)
  const totalNet            = rows.reduce((s, r) => s + r.net_pay, 0)
  const totalPay            = rows.reduce((s, r) => s + r.total_pay, 0)

  async function handleExport() {
    if (rows.length === 0) { toast.error('데이터가 없습니다.'); return }
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()

      const sheetRows = [
        ...rows.map((r) => ({
          연도: year,
          월: month,
          직원명: r.name,
          기본급: r.base_salary,
          인센티브: r.incentive,
          인센티브공제: r.incentive_deductions,
          공제액: r.deductions,
          '총지급액_공제후(기본+인센티브)': r.total_pay,
          지급일: r.paid_at ?? '',
        })),
        {
          연도: '',
          월: '',
          직원명: '합계',
          기본급: totalBase,
          인센티브: totalIncentive,
          인센티브공제: totalIncentiveDed,
          공제액: totalDeduct,
          '총지급액_공제후(기본+인센티브)': totalPay,
          지급일: '',
        },
      ]

      const ws = XLSX.utils.json_to_sheet(sheetRows)
      ws['!cols'] = [
        { wch: 6 }, { wch: 4 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
        { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 12 },
      ]
      XLSX.utils.book_append_sheet(wb, ws, '급여대장')
      XLSX.writeFile(wb, `티엔샤_급여대장_${year}년_${month}월.xlsx`)
      toast.success('급여대장 다운로드 완료')
    } catch {
      toast.error('내보내기 실패')
    } finally {
      setExporting(false)
    }
  }

  function prevMonth() {
    if (month === 1) { setYear((y) => y - 1); setMonth(12) }
    else setMonth((m) => m - 1)
  }
  function nextMonth() {
    if (month === 12) { setYear((y) => y + 1); setMonth(1) }
    else setMonth((m) => m + 1)
  }

  const incentiveCellProps = (row: PayrollRow): IncentiveCellProps => ({
    row,
    editingValue: editingIncentive[row.employee_id],
    isSaving: savingIncentive.has(row.employee_id),
    onStartEdit: startEdit,
    onCancelEdit: cancelEdit,
    onSave: saveIncentive,
    onChangeValue: changeValue,
  })

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">급여대장</h1>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg px-1 py-1">
            <button onClick={prevMonth} className="p-1 rounded hover:bg-white text-gray-500 hover:text-gray-900">
              <ChevronLeft size={16} />
            </button>
            <select
              className="bg-transparent text-sm font-semibold focus:outline-none cursor-pointer"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {[2023, 2024, 2025, 2026].map((y) => <option key={y} value={y}>{y}년</option>)}
            </select>
            <select
              className="bg-transparent text-sm font-semibold focus:outline-none cursor-pointer"
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>{m}월</option>
              ))}
            </select>
            <button onClick={nextMonth} className="p-1 rounded hover:bg-white text-gray-500 hover:text-gray-900">
              <ChevronRight size={16} />
            </button>
          </div>

          <Button onClick={handleExport} disabled={exporting || rows.length === 0} size="sm">
            <Download size={14} className="mr-1" />
            {exporting ? '생성 중...' : '엑셀 내보내기'}
          </Button>
        </div>
      </div>

      {/* 요약 카드 */}
      {rows.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-gray-500">기본급 합계</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold">{formatKRW(totalBase)}</div></CardContent>
          </Card>
          <Card className="border-blue-200 bg-blue-50">
            <CardHeader className="pb-1"><CardTitle className="text-xs text-blue-600">인센티브 합계</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold text-blue-800">{formatKRW(totalIncentive)}</div></CardContent>
          </Card>
          <Card className="border-green-200 bg-green-50">
            <CardHeader className="pb-1"><CardTitle className="text-xs text-green-600">총 지급액 (공제 후)</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold text-green-800">{formatKRW(totalPay)}</div></CardContent>
          </Card>
        </div>
      )}

      {/* 급여 테이블 - 모바일 카드 */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="bg-white rounded-lg border text-center py-8 text-gray-400 text-sm">불러오는 중...</div>
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-lg border text-center py-8 text-gray-400 text-sm">
            {year}년 {month}월 급여 데이터가 없습니다.<br />
            <span className="text-xs">직원/급여 메뉴에서 급여를 입력해주세요.</span>
          </div>
        ) : (
          <>
            {rows.map((r) => (
              <div key={r.employee_id} className="bg-white rounded-lg border p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-gray-900">{r.name}</span>
                  <span className="font-bold text-green-700">{formatKRW(r.total_pay)}</span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">기본급</span>
                    <span>{formatKRW(r.base_salary)}</span>
                  </div>
                  <div className="flex justify-between items-start">
                    <span className="text-gray-400 flex-shrink-0 mr-2">인센티브</span>
                    <IncentiveCell {...incentiveCellProps(r)} />
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">인센티브 공제</span>
                    <span className="text-red-500">{r.incentive_deductions > 0 ? `- ${formatKRW(r.incentive_deductions)}` : '-'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">공제액 (기본)</span>
                    <span className="text-red-500">{r.deductions > 0 ? `- ${formatKRW(r.deductions)}` : '-'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">실수령</span>
                    <span className="text-gray-600">{formatKRW(r.net_pay)}</span>
                  </div>
                </div>
                {r.paid_at && (
                  <div className="text-xs text-gray-400 mt-2">지급일: {new Date(r.paid_at).toLocaleDateString('ko-KR')}</div>
                )}
              </div>
            ))}
            <div className="bg-gray-50 rounded-lg border p-4">
              <div className="flex items-center justify-between font-bold">
                <span>합계</span>
                <span className="text-green-700">{formatKRW(totalPay)}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mt-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">기본급</span>
                  <span>{formatKRW(totalBase)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">인센티브</span>
                  <span className="text-blue-600">{formatKRW(totalIncentive)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">인센티브 공제</span>
                  <span className="text-red-500">- {formatKRW(totalIncentiveDed)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">공제액 (기본)</span>
                  <span className="text-red-500">- {formatKRW(totalDeduct)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">실수령</span>
                  <span>{formatKRW(totalNet)}</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 급여 테이블 - 데스크톱 */}
      <div className="hidden md:block bg-white rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>직원명</TableHead>
              <TableHead className="text-right">기본급</TableHead>
              <TableHead className="text-right">인센티브</TableHead>
              <TableHead className="text-right">인센티브 공제</TableHead>
              <TableHead className="text-right">공제액 (기본)</TableHead>
              <TableHead className="text-right">실수령액 (기본)</TableHead>
              <TableHead className="text-right font-semibold">총 지급액 (공제 후)</TableHead>
              <TableHead className="text-center">지급일</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-gray-400">불러오는 중...</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-gray-400">
                  {year}년 {month}월 급여 데이터가 없습니다.<br />
                  <span className="text-xs">직원/급여 메뉴에서 급여를 입력해주세요.</span>
                </TableCell>
              </TableRow>
            ) : (
              <>
                {rows.map((r) => (
                  <TableRow key={r.employee_id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-right">{formatKRW(r.base_salary)}</TableCell>
                    <TableCell className="text-right">
                      <IncentiveCell {...incentiveCellProps(r)} />
                    </TableCell>
                    <TableCell className="text-right text-red-500">
                      {r.incentive_deductions > 0 ? `- ${formatKRW(r.incentive_deductions)}` : '-'}
                    </TableCell>
                    <TableCell className="text-right text-red-500">
                      {r.deductions > 0 ? `- ${formatKRW(r.deductions)}` : '-'}
                    </TableCell>
                    <TableCell className="text-right text-gray-600">{formatKRW(r.net_pay)}</TableCell>
                    <TableCell className="text-right font-bold text-green-700">{formatKRW(r.total_pay)}</TableCell>
                    <TableCell className="text-center text-xs text-gray-500">
                      {r.paid_at ? new Date(r.paid_at).toLocaleDateString('ko-KR') : '-'}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-gray-50 font-bold border-t-2">
                  <TableCell>합계</TableCell>
                  <TableCell className="text-right">{formatKRW(totalBase)}</TableCell>
                  <TableCell className="text-right text-blue-600">{formatKRW(totalIncentive)}</TableCell>
                  <TableCell className="text-right text-red-500">- {formatKRW(totalIncentiveDed)}</TableCell>
                  <TableCell className="text-right text-red-500">- {formatKRW(totalDeduct)}</TableCell>
                  <TableCell className="text-right">{formatKRW(totalNet)}</TableCell>
                  <TableCell className="text-right text-green-700">{formatKRW(totalPay)}</TableCell>
                  <TableCell />
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-gray-400">
        * 인센티브 금액을 클릭하면 수동으로 조정할 수 있습니다. 수동 조정된 값은 정산에 반영됩니다.
        0으로 저장하면 자동 계산 값으로 복원됩니다.
      </p>
    </div>
  )
}
