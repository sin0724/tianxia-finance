'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from 'sonner'
import { formatKRW } from '@/lib/calculations/settlement'
import { Download, ChevronLeft, ChevronRight } from 'lucide-react'

type PayrollRow = {
  employee_id: string
  name: string
  base_salary: number
  incentive: number
  deductions: number
  net_pay: number   // base_salary - deductions
  total_pay: number // net_pay + incentive
  paid_at: string | null
}

export default function PayrollPage() {
  const supabase = createClient()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [rows, setRows] = useState<PayrollRow[]>([])
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

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
    ] = await Promise.all([
      supabase.from('monthly_payroll').select('*, employees(name)').eq('year', year).eq('month', month),
      supabase.from('employees').select('id, name, incentive_type, incentive_value').eq('active', true),
      supabase.from('monthly_incentives').select('*').eq('year', year).eq('month', month),
      supabase.from('payments').select('amount, manager, memo')
        .gte('payment_date', start).lte('payment_date', end).eq('matched', true),
      supabase.from('settings').select('*'),
    ])

    const settings = Object.fromEntries((settingsRows ?? []).map((s) => [s.key, Number(s.value)]))
    const vatRate = settings.vat_rate ?? 0.1

    // 인센티브 자동 계산 (정산 API와 동일 로직)
    const isPending = (memo: string | null) =>
      !!(memo?.includes('⚠ 잔금 처리 요망') || memo?.includes('🔴 미입금'))
    const confirmedPayments = (payments ?? []).filter((p) => !isPending(p.memo))

    const manualEmployeeIds = new Set((manualIncentives ?? []).map((i) => i.employee_id))

    const autoIncentiveMap: Record<string, number> = {}
    for (const emp of employees ?? []) {
      if (!emp.incentive_type || emp.incentive_value <= 0) continue
      if (manualEmployeeIds.has(emp.id)) continue // 수동 우선

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

    // 급여 행 조합
    const result: PayrollRow[] = (payroll ?? []).map((p) => {
      const emp = p as typeof p & { employees: { name: string } | null }
      const empId = p.employee_id ?? ''
      const incentive = manualIncentiveMap[empId] ?? autoIncentiveMap[empId] ?? 0
      return {
        employee_id: empId,
        name: emp.employees?.name ?? '-',
        base_salary: p.base_salary,
        incentive,
        deductions: p.deductions,
        net_pay: p.net_pay,
        total_pay: p.net_pay + incentive,
        paid_at: p.paid_at,
      }
    })

    setRows(result)
    setLoading(false)
  }

  const totalBase      = rows.reduce((s, r) => s + r.base_salary, 0)
  const totalIncentive = rows.reduce((s, r) => s + r.incentive, 0)
  const totalDeduct    = rows.reduce((s, r) => s + r.deductions, 0)
  const totalNet       = rows.reduce((s, r) => s + r.net_pay, 0)
  const totalPay       = rows.reduce((s, r) => s + r.total_pay, 0)

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
          공제액: r.deductions,
          실수령액_기본: r.net_pay,
          '총지급액_세전(기본+인센티브)': r.total_pay,
          지급일: r.paid_at ?? '',
        })),
        {
          연도: '',
          월: '',
          직원명: '합계',
          기본급: totalBase,
          인센티브: totalIncentive,
          공제액: totalDeduct,
          실수령액_기본: totalNet,
          '총지급액_세전(기본+인센티브)': totalPay,
          지급일: '',
        },
      ]

      const ws = XLSX.utils.json_to_sheet(sheetRows)
      // 열 너비
      ws['!cols'] = [
        { wch: 6 }, { wch: 4 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
        { wch: 12 }, { wch: 14 }, { wch: 20 }, { wch: 12 },
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

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">급여대장</h1>
        <div className="flex items-center gap-2">
          {/* 월 네비게이터 */}
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
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-gray-500">기본급 합계</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold">{formatKRW(totalBase)}</div></CardContent>
          </Card>
          <Card className="border-blue-200 bg-blue-50">
            <CardHeader className="pb-1"><CardTitle className="text-xs text-blue-600">인센티브 합계</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold text-blue-800">{formatKRW(totalIncentive)}</div></CardContent>
          </Card>
          <Card className="border-green-200 bg-green-50">
            <CardHeader className="pb-1"><CardTitle className="text-xs text-green-600">총 지급액 (세전)</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold text-green-800">{formatKRW(totalPay)}</div></CardContent>
          </Card>
        </div>
      )}

      {/* 급여 테이블 */}
      <div className="bg-white rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>직원명</TableHead>
              <TableHead className="text-right">기본급</TableHead>
              <TableHead className="text-right">인센티브</TableHead>
              <TableHead className="text-right">공제액</TableHead>
              <TableHead className="text-right">실수령액 (기본)</TableHead>
              <TableHead className="text-right font-semibold">총 지급액 (세전)</TableHead>
              <TableHead className="text-center">지급일</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400">불러오는 중...</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-gray-400">
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
                      {r.incentive > 0
                        ? <span className="text-blue-600 font-medium">{formatKRW(r.incentive)}</span>
                        : <span className="text-gray-300">-</span>}
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
                {/* 합계 행 */}
                <TableRow className="bg-gray-50 font-bold border-t-2">
                  <TableCell>합계</TableCell>
                  <TableCell className="text-right">{formatKRW(totalBase)}</TableCell>
                  <TableCell className="text-right text-blue-600">{formatKRW(totalIncentive)}</TableCell>
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
        * 인센티브는 해당 월 정산 기준과 동일하게 계산됩니다 (담당 계약건 공급가액 × 요율).
        수동으로 입력된 인센티브가 있으면 수동 값이 우선 적용됩니다.
      </p>
    </div>
  )
}
