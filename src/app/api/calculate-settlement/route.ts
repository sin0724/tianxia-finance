import { createClient } from '@/lib/supabase/server'
import { calculateMonthlySettlement } from '@/lib/calculations/settlement'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const { year, month } = await request.json()
  if (!year || !month) return NextResponse.json({ error: 'year, month 필수' }, { status: 400 })

  const supabase = await createClient()

  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  const isPendingMemo = (memo: string | null) =>
    !!(memo?.includes('⚠ 잔금 처리 요망') || memo?.includes('🔴 미입금'))

  // 매출/원가 계산: 프로젝트 연결된 입금 완료 결제
  const { data: rawPayments } = await supabase
    .from('payments')
    .select('*')
    .gte('payment_date', start)
    .lte('payment_date', end)
    .eq('matched', true)

  const payments = (rawPayments ?? []).filter((p) => !isPendingMemo(p.memo))

  // 인센티브 계산: 프로젝트 연결 여부와 무관하게 입금 완료된 전체 결제
  const { data: rawAllPayments } = await supabase
    .from('payments')
    .select('id, amount, manager, memo')
    .gte('payment_date', start)
    .lte('payment_date', end)

  const confirmedPayments = (rawAllPayments ?? []).filter((p) => !isPendingMemo(p.memo))

  // 프로젝트 구성 상품 (원가 계산용)
  // 실행비는 프로젝트별로 최초 입금월에만 1회 계산 (중복 방지)
  const projectIds = [...new Set(payments.map((p) => p.project_id).filter((id): id is string => id !== null))]

  // 해당 프로젝트들의 전체 입금 완료 이력 조회 (오래된 순)
  const { data: allProjectPaymentHistory } = projectIds.length > 0
    ? await supabase
        .from('payments')
        .select('project_id, payment_date, memo')
        .in('project_id', projectIds)
        .eq('matched', true)
        .order('payment_date', { ascending: true })
    : { data: [] }

  const currentYearMonth = `${year}-${String(month).padStart(2, '0')}`

  // 각 프로젝트의 최초 입금 완료월 산출 (pending 제외)
  const firstPaymentMonthMap: Record<string, string> = {}
  for (const p of allProjectPaymentHistory ?? []) {
    if (!p.project_id || isPendingMemo(p.memo)) continue
    if (!firstPaymentMonthMap[p.project_id]) {
      firstPaymentMonthMap[p.project_id] = p.payment_date.slice(0, 7) // 'YYYY-MM'
    }
  }

  // 이번 달이 최초 입금월인 프로젝트만 실행비에 포함
  const newProjectIds = projectIds.filter((id) => firstPaymentMonthMap[id] === currentYearMonth)

  const { data: projectItems } = newProjectIds.length > 0
    ? await supabase.from('project_items').select('*').in('project_id', newProjectIds)
    : { data: [] }

  // 지출
  const { data: rawExpenses } = await supabase
    .from('monthly_expenses')
    .select('*, expense_categories(parent_type)')
    .eq('year', year)
    .eq('month', month)

  const expenses = (rawExpenses ?? []).map((e) => ({
    ...e,
    category_type: (e.expense_categories as unknown as { parent_type: string } | null)?.parent_type,
  }))

  // 급여
  const { data: payroll } = await supabase
    .from('monthly_payroll')
    .select('*')
    .eq('year', year)
    .eq('month', month)

  // 시스템 설정
  const { data: settingsRows } = await supabase.from('settings').select('*')
  const settings = Object.fromEntries((settingsRows ?? []).map((s) => [s.key, Number(s.value)])) as {
    vat_rate: number
    corporate_tax_reserve: number
    retained_earnings_reserve: number
  }
  const vatRate = settings.vat_rate ?? 0.1

  // ── 인센티브 자동 계산 ──────────────────────────────────────
  // 직원별로 본인이 담당한 계약건(payment.manager === 직원명)의
  // 공급가액에만 인센티브 적용. 담당자가 없거나 직원 목록에 없으면 대표자 계약건.

  const { data: employees } = await supabase
    .from('employees')
    .select('id, name, incentive_type, incentive_value')
    .eq('active', true)

  const autoIncentives = (employees ?? [])
    .filter((e) => e.incentive_type && e.incentive_value > 0)
    .map((e) => {
      // 해당 직원이 담당한 입금 완료 결제건 (프로젝트 연결 여부 무관)
      const myPayments = confirmedPayments.filter(
        (p) => p.manager?.trim().toLowerCase() === e.name.trim().toLowerCase()
      )
      if (myPayments.length === 0) return null

      const myRevenue     = myPayments.reduce((sum, p) => sum + p.amount, 0)
      const mySupplyValue = myRevenue / (1 + vatRate)

      const amount = e.incentive_type === 'percent'
        ? Math.round(mySupplyValue * e.incentive_value / 100)
        : e.incentive_value

      return {
        id: `auto_${e.id}`,
        year,
        month,
        employee_id: e.id,
        amount,
        basis: e.incentive_type === 'percent' ? mySupplyValue : null,
        memo: `담당계약 공급가액 ${Math.round(mySupplyValue).toLocaleString()}원 기준`,
        created_at: new Date().toISOString(),
      }
    })
    .filter((i): i is NonNullable<typeof i> => i !== null)

  // 수동 입력된 monthly_incentives가 있으면 해당 직원 건은 수동 값 우선
  const { data: manualIncentives } = await supabase
    .from('monthly_incentives')
    .select('*')
    .eq('year', year)
    .eq('month', month)

  const manualEmployeeIds = new Set((manualIncentives ?? []).map((i) => i.employee_id))
  const incentives = [
    ...autoIncentives.filter((i) => !manualEmployeeIds.has(i.employee_id)),
    ...(manualIncentives ?? []),
  ]
  // ─────────────────────────────────────────────────────────────

  const result = calculateMonthlySettlement({
    year,
    month,
    payments,
    projectItems: projectItems ?? [],
    expenses,
    incentives,
    payroll: payroll ?? [],
    settings: {
      vat_rate: vatRate,
      corporate_tax_reserve: settings.corporate_tax_reserve ?? 0.1,
      retained_earnings_reserve: settings.retained_earnings_reserve ?? 0.08,
    },
  })

  const { error } = await supabase.from('monthly_settlements').upsert({
    year,
    month,
    total_revenue: result.totalRevenue,
    supply_value: result.supplyValue,
    total_incentive: result.totalIncentive,
    total_product_cost: result.totalProductCost,
    gross_profit: result.grossProfit,
    total_fixed_cost: result.totalFixedCost,
    total_variable_cost: result.totalVariableCost,
    total_special_cost: result.totalSpecialCost,
    total_payroll: result.totalPayroll,
    operating_profit: result.operatingProfit,
    corporate_tax_reserve: result.corporateTaxReserve,
    retained_earnings: result.retainedEarnings,
    distributable_profit: result.distributableProfit,
    representative_share: result.representativeShare,
    calculated_at: new Date().toISOString(),
  }, { onConflict: 'year,month' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, result })
}

// 정산 초기화
export async function DELETE(request: Request) {
  const { year, month } = await request.json()
  if (!year || !month) return NextResponse.json({ error: 'year, month 필수' }, { status: 400 })

  const supabase = await createClient()
  const { error } = await supabase
    .from('monthly_settlements')
    .delete()
    .eq('year', year)
    .eq('month', month)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
