'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useMonth } from '@/components/shared/month-context'
import { MonthNavigator } from '@/components/shared/month-navigator'
import { hiredBy, resolveSchedule, workedThrough } from '@/lib/payroll/tax'
import { toast } from '@/lib/toast'
import type { Employee } from '@/types/database'
import { Calculator, Save } from 'lucide-react'

interface Attendance {
  rowId: string | null
  work_hours: string
  absent_days: string
  absent_memo: string
}

const blank: Attendance = { rowId: null, work_hours: '0', absent_days: '0', absent_memo: '' }

/** 8.5시간, 0.5일 같은 소수를 살린다 */
const numF = (v: string) => Number(v) || 0

const scheduleFor = (e: Employee, year: number, month: number) => resolveSchedule(
  { days: e.work_days, start: e.work_start_time, end: e.work_end_time, breakMinutes: e.break_minutes ?? 0 },
  year, month,
)

/**
 * 월별 근태 기록 — 근무시간·결근·결근 메모. 기록용이라 급여 금액에는 쓰지 않는다.
 * 금액 칸과 같은 행에 있으므로 명세서 금액을 덮어쓰지 않게 이 세 칸만 저장한다.
 */
export function AttendanceTab({ employees }: { employees: Employee[] }) {
  const supabase = createClient()
  const { year, month } = useMonth()
  const [forms, setForms] = useState<Record<string, Attendance>>({})
  const [changed, setChanged] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('monthly_payroll')
      .select('id, employee_id, work_hours, absent_days, absent_memo').eq('year', year).eq('month', month)
    if (error) { toast.error(error.message); return }
    const next: Record<string, Attendance> = {}
    for (const p of data ?? []) {
      if (!p.employee_id) continue
      next[p.employee_id] = {
        rowId: p.id,
        work_hours: String(p.work_hours ?? 0),
        absent_days: String(p.absent_days ?? 0),
        absent_memo: p.absent_memo ?? '',
      }
    }
    setForms(next)
    setChanged(new Set())
  }, [supabase, year, month])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- 달이 바뀌면 다시 불러온다
  useEffect(() => { load() }, [load])

  const mm = String(month).padStart(2, '0')
  const start = `${year}-${mm}-01`
  const end = `${year}-${mm}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`
  const targets = employees.filter((e) => (hiredBy(e, end) && workedThrough(e, start)) || forms[e.id])

  function update(id: string, patch: Partial<Attendance>) {
    setForms((prev) => ({ ...prev, [id]: { ...(prev[id] ?? blank), ...patch } }))
    setChanged((prev) => new Set(prev).add(id))
  }

  function fillHours(e: Employee) {
    const schedule = scheduleFor(e, year, month)
    if (!schedule) return
    const days = Math.max(0, schedule.monthlyDays - numF(forms[e.id]?.absent_days ?? '0'))
    update(e.id, { work_hours: String(Math.round(days * schedule.dailyHours * 100) / 100) })
  }

  async function save() {
    setSaving(true)
    const ids = [...changed]
    const values = (f: Attendance) => ({
      work_hours: numF(f.work_hours), absent_days: numF(f.absent_days), absent_memo: f.absent_memo.trim() || null,
    })
    const results = await Promise.all(ids.map((id) => {
      const f = forms[id]
      return f.rowId
        ? supabase.from('monthly_payroll').update(values(f)).eq('id', f.rowId)
        : supabase.from('monthly_payroll').insert({ year, month, employee_id: id, base_salary: 0, net_pay: 0, ...values(f) })
    }))
    setSaving(false)
    const failed = results.find((r) => r.error)
    if (failed?.error) { toast.error('저장 실패: ' + failed.error.message); return }
    toast.success(`${month}월 근태를 저장했습니다.`)
    await load()
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MonthNavigator />
        <Button size="sm" onClick={save} disabled={saving || changed.size === 0}>
          <Save size={14} className="mr-1" />{saving ? '저장 중...' : '저장'}
        </Button>
      </div>

      <div className="bg-white rounded-lg border divide-y">
        <div className="hidden md:grid md:grid-cols-[1fr_1.1fr_0.8fr_2fr] md:gap-3 px-4 py-2 bg-gray-50 text-xs font-medium text-gray-500">
          <div>직원</div><div>근무시간</div><div>결근일</div><div>결근 메모</div>
        </div>
        {targets.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">{month}월 재직 직원이 없습니다.</div>
        ) : targets.map((e) => {
          const f = forms[e.id] ?? blank
          const schedule = scheduleFor(e, year, month)
          return (
            <div key={e.id} className="px-4 py-3 space-y-2 md:space-y-0 md:grid md:grid-cols-[1fr_1.1fr_0.8fr_2fr] md:gap-3 md:items-center">
              <div className="min-w-0">
                <div className="font-medium text-gray-900">{e.name}</div>
                {schedule && <div className="text-xs text-gray-400">소정 {schedule.monthlyDays}일 · {Math.round(schedule.monthlyHours * 100) / 100}시간</div>}
              </div>
              <div className="flex items-center gap-1">
                <Input type="number" step="0.5" min="0" className="h-8 w-24 text-sm text-right" aria-label={`${e.name} 근무시간`}
                  value={f.work_hours} onChange={(ev) => update(e.id, { work_hours: ev.target.value })} />
                <span className="text-xs text-gray-400">시간</span>
                {schedule && (
                  <button type="button" onClick={() => fillHours(e)} title="소정근로에서 결근을 뺀 시간으로 채우기"
                    className="text-gray-300 hover:text-purple-600 transition-colors">
                    <Calculator size={14} />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Input type="number" step="0.5" min="0" className="h-8 w-20 text-sm text-right" aria-label={`${e.name} 결근일`}
                  value={f.absent_days} onChange={(ev) => update(e.id, { absent_days: ev.target.value })} />
                <span className="text-xs text-gray-400">일</span>
              </div>
              <Input className="h-8 text-sm" placeholder="날짜·사유 (예: 10/3 무단, 10/17 오전 병원)" aria-label={`${e.name} 결근 메모`}
                value={f.absent_memo} onChange={(ev) => update(e.id, { absent_memo: ev.target.value })} />
            </div>
          )
        })}
      </div>
      <p className="text-xs text-gray-400">* 기록용입니다. 급여 금액은 세무사 명세서가 기준이라 여기 값으로 다시 계산하지 않습니다.</p>
    </div>
  )
}
