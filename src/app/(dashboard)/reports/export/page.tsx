'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Download } from 'lucide-react'

type ExportScope = 'month' | 'year'

export default function ExportPage() {
  const supabase = createClient()
  const now = new Date()
  const [scope, setScope] = useState<ExportScope>('month')
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [loading, setLoading] = useState(false)

  async function handleExport() {
    setLoading(true)
    try {
      const XLSX = await import('xlsx')

      const startMonth = scope === 'month' ? month : 1
      const endMonth = scope === 'month' ? month : 12
      const startDate = `${year}-${String(startMonth).padStart(2, '0')}-01`
      const endDate = new Date(year, endMonth, 0).toISOString().split('T')[0]

      // 데이터 병렬 로드
      const [
        { data: payments },
        { data: expenses },
        { data: payroll },
        { data: incentives },
        { data: settlements },
      ] = await Promise.all([
        supabase
          .from('payments')
          .select('*, projects(name, clients(name))')
          .gte('payment_date', startDate)
          .lte('payment_date', endDate)
          .order('payment_date'),
        supabase
          .from('monthly_expenses')
          .select('*, expense_categories(name, parent_type)')
          .gte('year', year).lte('year', year)
          .gte('month', startMonth).lte('month', endMonth)
          .order('year').order('month'),
        supabase
          .from('monthly_payroll')
          .select('*, employees(name)')
          .eq('year', year)
          .gte('month', startMonth).lte('month', endMonth)
          .order('month'),
        supabase
          .from('monthly_incentives')
          .select('*, employees(name)')
          .eq('year', year)
          .gte('month', startMonth).lte('month', endMonth)
          .order('month'),
        supabase
          .from('monthly_settlements')
          .select('*')
          .eq('year', year)
          .gte('month', startMonth).lte('month', endMonth)
          .order('month'),
      ])

      const wb = XLSX.utils.book_new()

      // 시트 1: 매출 상세
      const paymentRows = (payments ?? []).map((p: unknown) => {
        const pay = p as {
          payment_date: string; amount: number; payment_type: string | null
          manager: string | null; memo: string | null
          projects: { name: string; clients: { name: string } | null } | null
        }
        return {
          결제일: pay.payment_date,
          클라이언트: pay.projects?.clients?.name ?? '',
          프로젝트: pay.projects?.name ?? '미매칭',
          유형: pay.payment_type ?? '',
          담당자: pay.manager ?? '',
          금액: pay.amount,
          메모: pay.memo ?? '',
        }
      })
      const ws1 = XLSX.utils.json_to_sheet(paymentRows.length ? paymentRows : [{ 결제일: '', 클라이언트: '', 프로젝트: '', 유형: '', 담당자: '', 금액: '', 메모: '' }])
      XLSX.utils.book_append_sheet(wb, ws1, '매출상세')

      // 시트 2: 지출 상세
      const expenseRows = (expenses ?? []).map((e: unknown) => {
        const exp = e as {
          year: number; month: number; amount: number; memo: string | null
          expense_categories: { name: string; parent_type: string } | null
        }
        return {
          연도: exp.year,
          월: exp.month,
          유형: exp.expense_categories?.parent_type === 'fixed' ? '고정비' : exp.expense_categories?.parent_type === 'variable' ? '변동비' : '특수비',
          카테고리: exp.expense_categories?.name ?? '',
          금액: exp.amount,
          메모: exp.memo ?? '',
        }
      })
      const ws2 = XLSX.utils.json_to_sheet(expenseRows.length ? expenseRows : [{ 연도: '', 월: '', 유형: '', 카테고리: '', 금액: '', 메모: '' }])
      XLSX.utils.book_append_sheet(wb, ws2, '지출상세')

      // 시트 3: 급여대장
      const payrollRows = (payroll ?? []).map((p: unknown) => {
        const pr = p as {
          year: number; month: number; base_salary: number; deductions: number; net_pay: number; paid_at: string | null
          employees: { name: string } | null
        }
        return {
          연도: pr.year,
          월: pr.month,
          직원명: pr.employees?.name ?? '',
          기본급: pr.base_salary,
          공제액: pr.deductions,
          실수령액: pr.net_pay,
          지급일: pr.paid_at ?? '',
        }
      })

      const incentiveRows = (incentives ?? []).map((i: unknown) => {
        const inc = i as {
          year: number; month: number; amount: number; basis: number | null; memo: string | null
          employees: { name: string } | null
        }
        return {
          연도: inc.year,
          월: inc.month,
          직원명: inc.employees?.name ?? '',
          기본급: '',
          공제액: '',
          실수령액: inc.amount,
          지급일: `인센티브 (기준: ${inc.basis ?? ''})`,
        }
      })

      const ws3 = XLSX.utils.json_to_sheet([...payrollRows, ...incentiveRows].length
        ? [...payrollRows, ...incentiveRows]
        : [{ 연도: '', 월: '', 직원명: '', 기본급: '', 공제액: '', 실수령액: '', 지급일: '' }])
      XLSX.utils.book_append_sheet(wb, ws3, '급여대장')

      // 시트 4: 정산내역
      const settlementRows = (settlements ?? []).map((s: {
        year: number; month: number; total_revenue: number; supply_value: number
        total_incentive: number; total_product_cost: number; gross_profit: number
        total_fixed_cost: number; total_variable_cost: number; total_special_cost: number
        total_payroll: number; operating_profit: number; corporate_tax_reserve: number
        retained_earnings: number; distributable_profit: number; representative_share: number
      }) => ({
        연도: s.year,
        월: s.month,
        총매출: s.total_revenue,
        공급가액: s.supply_value,
        인센티브: s.total_incentive,
        상품원가: s.total_product_cost,
        매출총이익: s.gross_profit,
        고정비: s.total_fixed_cost,
        변동비: s.total_variable_cost,
        특수비용: s.total_special_cost,
        급여: s.total_payroll,
        영업이익: s.operating_profit,
        법인세적립: s.corporate_tax_reserve,
        유보금적립: s.retained_earnings,
        분배가능이익: s.distributable_profit,
        '대표자1인정산액': s.representative_share,
      }))
      const ws4 = XLSX.utils.json_to_sheet(settlementRows.length ? settlementRows : [{}])
      XLSX.utils.book_append_sheet(wb, ws4, '정산내역')

      // 시트 5: 손익요약 (있는 정산 데이터 기준)
      if ((settlements ?? []).length > 0) {
        const totalRevenue = (settlements ?? []).reduce((s, r) => s + r.total_revenue, 0)
        const totalOp = (settlements ?? []).reduce((s, r) => s + r.operating_profit, 0)
        const totalDist = (settlements ?? []).reduce((s, r) => s + r.distributable_profit, 0)
        const summaryData = [
          { 항목: '총매출', 금액: totalRevenue },
          { 항목: '공급가액', 금액: (settlements ?? []).reduce((s, r) => s + r.supply_value, 0) },
          { 항목: '총 인센티브', 금액: (settlements ?? []).reduce((s, r) => s + r.total_incentive, 0) },
          { 항목: '총 상품원가', 금액: (settlements ?? []).reduce((s, r) => s + r.total_product_cost, 0) },
          { 항목: '매출총이익', 금액: (settlements ?? []).reduce((s, r) => s + r.gross_profit, 0) },
          { 항목: '총 고정비', 금액: (settlements ?? []).reduce((s, r) => s + r.total_fixed_cost, 0) },
          { 항목: '총 변동비', 금액: (settlements ?? []).reduce((s, r) => s + r.total_variable_cost, 0) },
          { 항목: '총 특수비용', 금액: (settlements ?? []).reduce((s, r) => s + r.total_special_cost, 0) },
          { 항목: '총 급여', 금액: (settlements ?? []).reduce((s, r) => s + r.total_payroll, 0) },
          { 항목: '영업이익', 금액: totalOp },
          { 항목: '법인세 적립 (10%)', 금액: (settlements ?? []).reduce((s, r) => s + r.corporate_tax_reserve, 0) },
          { 항목: '유보금 적립 (8%)', 금액: (settlements ?? []).reduce((s, r) => s + r.retained_earnings, 0) },
          { 항목: '분배 가능 이익', 금액: totalDist },
          { 항목: '대표자 1인 정산액 (50%)', 금액: totalDist / 2 },
        ]
        const ws5 = XLSX.utils.json_to_sheet(summaryData)
        XLSX.utils.book_append_sheet(wb, ws5, '손익요약')
      }

      const filename = scope === 'month'
        ? `티엔샤_${year}년_${month}월_정산.xlsx`
        : `티엔샤_${year}년_연간정산.xlsx`

      XLSX.writeFile(wb, filename)
      toast.success(`${filename} 다운로드 완료`)
    } catch (e) {
      console.error(e)
      toast.error('내보내기 실패')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6 max-w-lg">
      <h1 className="text-2xl font-bold">엑셀 내보내기</h1>

      <div className="bg-white rounded-lg border p-6 space-y-5">
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">내보내기 범위</label>
          <div className="flex gap-3">
            {[{ value: 'month', label: '월별' }, { value: 'year', label: '연간' }].map(({ value, label }) => (
              <label key={value} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  value={value}
                  checked={scope === value}
                  onChange={() => setScope(value as ExportScope)}
                  className="accent-blue-600"
                />
                <span className="text-sm">{label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex gap-3">
          <div className="space-y-1 flex-1">
            <label className="text-sm font-medium text-gray-700">연도</label>
            <select
              className="w-full border rounded-md px-3 py-2 text-sm"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {[2023, 2024, 2025, 2026].map((y) => <option key={y} value={y}>{y}년</option>)}
            </select>
          </div>
          {scope === 'month' && (
            <div className="space-y-1 flex-1">
              <label className="text-sm font-medium text-gray-700">월</label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm"
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>{m}월</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="rounded-md bg-gray-50 border p-3 text-xs text-gray-500 space-y-1">
          <p className="font-medium text-gray-700">포함 시트</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>매출상세 — 결제 내역 (날짜, 클라이언트, 프로젝트, 금액)</li>
            <li>지출상세 — 월별 지출 카테고리별 내역</li>
            <li>급여대장 — 급여 + 인센티브 지급 내역</li>
            <li>정산내역 — 월별 정산 계산 결과</li>
            <li>손익요약 — 기간 합산 손익 요약 (정산 완료된 달만)</li>
          </ul>
        </div>

        <Button className="w-full" onClick={handleExport} disabled={loading}>
          <Download size={16} className="mr-2" />
          {loading ? '생성 중...' : `${scope === 'month' ? `${year}년 ${month}월` : `${year}년 연간`} 엑셀 다운로드`}
        </Button>
      </div>
    </div>
  )
}
