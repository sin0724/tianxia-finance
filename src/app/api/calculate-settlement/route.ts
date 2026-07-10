import { createClient } from '@/lib/supabase/server'
import { calculateMonthlySettlement, type SettlementResult } from '@/lib/calculations/settlement'
import { NextResponse } from 'next/server'

type EmployeeRow = { id: string; name: string; incentive_type: string | null; incentive_value: number }
type PaymentRow = { manager?: string | null; amount: number }

function computeAutoIncentives(
  employees: EmployeeRow[],
  payments: PaymentRow[],
  vatRate: number,
  year: number,
  month: number,
  prefix: string
) {
  return employees
    .filter((e) => e.incentive_type && e.incentive_value > 0)
    .map((e) => {
      const myPayments = payments.filter(
        (p) => p.manager?.trim().toLowerCase() === e.name.trim().toLowerCase()
      )
      if (myPayments.length === 0) return null
      const myRevenue = myPayments.reduce((sum, p) => sum + p.amount, 0)
      const mySupplyValue = myRevenue / (1 + vatRate)
      const amount =
        e.incentive_type === 'percent'
          ? Math.round((mySupplyValue * e.incentive_value) / 100)
          : e.incentive_value
      return {
        id: `${prefix}_${e.id}`,
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
}

function toSnakeCase(r: SettlementResult) {
  return {
    total_revenue: r.totalRevenue,
    supply_value: r.supplyValue,
    total_incentive: r.totalIncentive,
    total_product_cost: r.totalProductCost,
    gross_profit: r.grossProfit,
    total_fixed_cost: r.totalFixedCost,
    total_variable_cost: r.totalVariableCost,
    total_special_cost: r.totalSpecialCost,
    total_payroll: r.totalPayroll,
    gonggu_gross_sales: r.gongguGrossSales,
    gonggu_margin: r.gongguMargin,
    operating_profit: r.operatingProfit,
    corporate_tax_reserve: r.corporateTaxReserve,
    retained_earnings: r.retainedEarnings,
    distributable_profit: r.distributableProfit,
    representative_share: r.representativeShare,
  }
}

async function computeBothSettlements(year: number, month: number) {
  const supabase = await createClient()

  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  const { data: rawAllPayments } = await supabase
    .from('payments')
    .select('*')
    .gte('payment_date', start)
    .lte('payment_date', end)

  // 취소된 프로젝트는 매출·실행비 계산에서 제외
  const { data: cancelledProjects } = await supabase
    .from('projects')
    .select('id')
    .eq('status', 'cancelled')
  const cancelledIds = new Set((cancelledProjects ?? []).map((p) => p.id))

  const allPaymentsInMonth = rawAllPayments ?? []
  const confirmedPayments = allPaymentsInMonth.filter(
    (p) => p.status === 'confirmed' && !p.excluded && !(p.project_id && cancelledIds.has(p.project_id))
  )

  // 전체 기간 미수금 (날짜 무관) — 수금 관리 탭·대시보드와 동일 기준
  const { data: rawAllPending } = await supabase
    .from('payments')
    .select('*')
    .in('status', ['balance_due', 'unpaid'])

  const allPendingPayments = (rawAllPending ?? []).filter(
    (p) => !(p.project_id && cancelledIds.has(p.project_id))
  )
  // 예상 정산: 이번 달 확정 + 전체 미수금 전액 수취 가정
  const paymentsForProjected = [...confirmedPayments, ...allPendingPayments]

  const currentYearMonth = `${year}-${String(month).padStart(2, '0')}`

  // ── 확정 결제 기준 프로젝트 실행비 ──────────────────────────────
  const projectIds = [
    ...new Set(confirmedPayments.map((p) => p.project_id).filter((id): id is string => id !== null)),
  ]

  const { data: allProjectPaymentHistory } =
    projectIds.length > 0
      ? await supabase
          .from('payments')
          .select('project_id, payment_date, status')
          .in('project_id', projectIds)
          .eq('matched', true)
          .order('payment_date', { ascending: true })
      : { data: [] }

  const firstPaymentMonthMap: Record<string, string> = {}
  for (const p of allProjectPaymentHistory ?? []) {
    if (!p.project_id || p.status !== 'confirmed') continue
    if (!firstPaymentMonthMap[p.project_id]) {
      firstPaymentMonthMap[p.project_id] = p.payment_date.slice(0, 7)
    }
  }

  const newProjectIds = projectIds.filter((id) => firstPaymentMonthMap[id] === currentYearMonth)

  const { data: projectItems } =
    newProjectIds.length > 0
      ? await supabase.from('project_items').select('*').in('project_id', newProjectIds)
      : { data: [] }

  // ── 미수금 포함 기준 프로젝트 실행비 ──────────────────────────────
  const allProjectIds = [
    ...new Set(paymentsForProjected.map((p) => p.project_id).filter((id): id is string => id !== null)),
  ]

  const confirmedProjectIdSet = new Set(projectIds)
  const pendingOnlyProjectIds = allProjectIds.filter((id) => !confirmedProjectIdSet.has(id))

  const { data: pendingOnlyHistory } =
    pendingOnlyProjectIds.length > 0
      ? await supabase
          .from('payments')
          .select('project_id, payment_date, status')
          .in('project_id', pendingOnlyProjectIds)
          .eq('matched', true)
          .order('payment_date', { ascending: true })
      : { data: [] }

  const extendedFirstPaymentMonthMap = { ...firstPaymentMonthMap }
  for (const p of pendingOnlyHistory ?? []) {
    if (!p.project_id || p.status !== 'confirmed') continue
    if (!extendedFirstPaymentMonthMap[p.project_id]) {
      extendedFirstPaymentMonthMap[p.project_id] = p.payment_date.slice(0, 7)
    }
  }
  for (const id of allProjectIds) {
    if (!extendedFirstPaymentMonthMap[id]) {
      extendedFirstPaymentMonthMap[id] = currentYearMonth
    }
  }

  const projectedNewProjectIds = allProjectIds.filter(
    (id) => extendedFirstPaymentMonthMap[id] === currentYearMonth
  )
  const newProjectIdSet = new Set(newProjectIds)
  const additionalProjectIds = projectedNewProjectIds.filter((id) => !newProjectIdSet.has(id))

  const { data: additionalProjectItems } =
    additionalProjectIds.length > 0
      ? await supabase.from('project_items').select('*').in('project_id', additionalProjectIds)
      : { data: [] }

  const allProjectItems = [...(projectItems ?? []), ...(additionalProjectItems ?? [])]

  // ── 공통 데이터 ───────────────────────────────────────────────
  const { data: rawExpenses } = await supabase
    .from('monthly_expenses')
    .select('*, expense_categories(parent_type)')
    .eq('year', year)
    .eq('month', month)

  // parent_type 스냅샷 우선, 없으면 카테고리 조인 fallback (구버전 데이터 호환)
  const expenses = (rawExpenses ?? [])
    .map((e) => ({
      ...e,
      category_type: e.parent_type ?? (e.expense_categories as unknown as { parent_type: string } | null)?.parent_type,
    }))
    .filter((e) => !!e.category_type)

  const { data: payroll } = await supabase
    .from('monthly_payroll')
    .select('*')
    .eq('year', year)
    .eq('month', month)

  // 공구 사업부 실적 — 수출 영세율(0%) 적용. 취급액은 참고 표기, 마진 전액 영업이익에 가산
  const { data: gongguRows } = await supabase
    .from('gonggu_sales')
    .select('gross_sales, margin')
    .eq('year', year)
    .eq('month', month)
  const gonggu = {
    grossSales: (gongguRows ?? []).reduce((sum, r) => sum + r.gross_sales, 0),
    margin: (gongguRows ?? []).reduce((sum, r) => sum + r.margin, 0),
  }

  const { data: settingsRows } = await supabase.from('settings').select('*')
  const settings = Object.fromEntries((settingsRows ?? []).map((s) => [s.key, Number(s.value)])) as {
    vat_rate: number
    corporate_tax_reserve: number
    retained_earnings_reserve: number
  }
  const vatRate = settings.vat_rate ?? 0.1

  const { data: employees } = await supabase
    .from('employees')
    .select('id, name, incentive_type, incentive_value')
    .eq('active', true)

  const { data: manualIncentives } = await supabase
    .from('monthly_incentives')
    .select('*')
    .eq('year', year)
    .eq('month', month)

  const manualEmployeeIds = new Set((manualIncentives ?? []).map((i) => i.employee_id))

  // ── 인센티브 계산 ────────────────────────────────────────────
  const autoIncentives = computeAutoIncentives(employees ?? [], confirmedPayments, vatRate, year, month, 'auto')
  const incentives = [
    ...autoIncentives.filter((i) => !manualEmployeeIds.has(i.employee_id)),
    ...(manualIncentives ?? []),
  ]

  const projectedAutoIncentives = computeAutoIncentives(employees ?? [], paymentsForProjected, vatRate, year, month, 'proj')
  const projectedIncentives = [
    ...projectedAutoIncentives.filter((i) => !manualEmployeeIds.has(i.employee_id)),
    ...(manualIncentives ?? []),
  ]

  const settlementSettings = {
    vat_rate: vatRate,
    corporate_tax_reserve: settings.corporate_tax_reserve ?? 0.1,
    retained_earnings_reserve: settings.retained_earnings_reserve ?? 0.08,
  }

  const baseResult = calculateMonthlySettlement({
    year, month,
    payments: confirmedPayments,
    projectItems: projectItems ?? [],
    expenses,
    incentives,
    payroll: payroll ?? [],
    gonggu,
    settings: settlementSettings,
  })

  const baseProjectedResult = calculateMonthlySettlement({
    year, month,
    payments: paymentsForProjected,
    projectItems: allProjectItems,
    expenses,
    incentives: projectedIncentives,
    payroll: payroll ?? [],
    gonggu,
    settings: settlementSettings,
  })

  // 대표자 실제 분배율 적용 (첫 번째 대표자 기준)
  const { data: repsForShare } = await supabase
    .from('representatives').select('share_ratio').order('created_at').limit(1)
  const primaryRatio = (repsForShare?.[0]?.share_ratio ?? 50) / 100

  const result = {
    ...baseResult,
    representativeShare: Math.floor(baseResult.distributableProfit * primaryRatio),
  }
  const projectedResult = {
    ...baseProjectedResult,
    representativeShare: Math.floor(baseProjectedResult.distributableProfit * primaryRatio),
  }

  const pendingTotal = allPendingPayments.reduce((sum, p) => sum + p.amount, 0)
  const pendingCount = allPendingPayments.length

  return { supabase, result, projectedResult, pendingTotal, pendingCount }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const year = Number(searchParams.get('year'))
  const month = Number(searchParams.get('month'))
  if (!year || !month) return NextResponse.json({ error: 'year, month 필수' }, { status: 400 })

  const { result, projectedResult, pendingTotal, pendingCount } = await computeBothSettlements(year, month)

  return NextResponse.json({
    success: true,
    result: toSnakeCase(result),
    projectedResult: toSnakeCase(projectedResult),
    pendingTotal,
    pendingCount,
  })
}

export async function POST(request: Request) {
  const { year, month } = await request.json()
  if (!year || !month) return NextResponse.json({ error: 'year, month 필수' }, { status: 400 })

  const { supabase, result, projectedResult, pendingTotal, pendingCount } = await computeBothSettlements(year, month)

  const { error } = await supabase.from('monthly_settlements').upsert(
    {
      year,
      month,
      ...toSnakeCase(result),
      calculated_at: new Date().toISOString(),
    },
    { onConflict: 'year,month' }
  )

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    success: true,
    result: toSnakeCase(result),
    projectedResult: toSnakeCase(projectedResult),
    pendingTotal,
    pendingCount,
  })
}

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
