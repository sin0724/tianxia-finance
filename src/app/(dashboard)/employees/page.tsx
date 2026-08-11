'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/lib/toast'
import { ArrowRight, Plus, Pencil, UserMinus, UserPlus } from 'lucide-react'
import { formatKRW } from '@/lib/calculations/settlement'
import { CurrencyInput } from '@/components/ui/currency-input'
import { dailyWorkHours, dailySpanMinutes, requiredBreakMinutes, minimumWage } from '@/lib/payroll/tax'
import type { Employee } from '@/types/database'

const WEEK_DAYS = ['월', '화', '수', '목', '금', '토', '일'] as const

/** 자주 쓰는 휴게시간 — 점심 1시간이 기본값에 가깝다 */
const BREAK_PRESETS = [0, 30, 60, 90] as const

const fmtHours = (h: number) => `${Math.round(h * 100) / 100}h`

function scheduleOf(e: Employee) {
  return {
    days: e.work_days,
    start: e.work_start_time,
    end: e.work_end_time,
    breakMinutes: e.break_minutes ?? 0,
  }
}

function formatWorkSchedule(e: Employee) {
  const days = e.work_days ? e.work_days.split(',').join('·') : ''
  const time = e.work_start_time && e.work_end_time
    ? `${e.work_start_time}~${e.work_end_time}`
    : (e.work_start_time || e.work_end_time || '')
  const daily = dailyWorkHours(scheduleOf(e))
  const rest = e.break_minutes ? `휴게 ${e.break_minutes}분` : ''
  const net = daily !== null && daily > 0 ? `1일 ${fmtHours(daily)}` : ''
  return [days, time, rest, net].filter(Boolean).join(' · ')
}

const emptyForm = {
  name: '',
  position: '',
  employee_type: 'full_time' as 'full_time' | 'part_time',
  base_salary: '',
  hourly_wage: '',
  work_days: [] as string[],
  work_start_time: '',
  work_end_time: '',
  break_minutes: '0',
  wage_includes_holiday: false,
  incentive_type: '' as '' | 'percent' | 'fixed',
  incentive_value: '',
  insured: false,
  sort_order: '',
  hired_at: '',
  slack_user_id: '',
}

/**
 * 직원 마스터 — 몇 달에 한 번 바뀌는 설정값만 둔다.
 * 매달 반복되는 급여 산정·확정·지급은 /payroll 에서 처리한다.
 */
export default function EmployeesPage() {
  const supabase = createClient()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [retired, setRetired] = useState<Employee[]>([])
  const [showRetired, setShowRetired] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Employee | null>(null)
  const [form, setForm] = useState(emptyForm)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('employees')
      .select('*')
      .order('sort_order', { nullsFirst: false })
      .order('name')
    const all = data ?? []
    setEmployees(all.filter((e) => e.active))
    setRetired(all.filter((e) => !e.active))
    setLoading(false)
  }, [supabase])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- 최초 진입 시 마스터 목록 로드
  useEffect(() => { load() }, [load])

  function openAdd() {
    setEditing(null)
    setForm({ ...emptyForm, sort_order: String(employees.length + 1) })
    setDialogOpen(true)
  }

  function openEdit(e: Employee) {
    setEditing(e)
    setForm({
      name: e.name,
      position: e.position ?? '',
      employee_type: e.employee_type ?? 'full_time',
      base_salary: String(e.base_salary ?? 0),
      hourly_wage: String(e.hourly_wage ?? 0),
      work_days: e.work_days ? e.work_days.split(',') : [],
      work_start_time: e.work_start_time ?? '',
      work_end_time: e.work_end_time ?? '',
      break_minutes: String(e.break_minutes ?? 0),
      wage_includes_holiday: e.wage_includes_holiday ?? false,
      incentive_type: e.incentive_type ?? '',
      incentive_value: String(e.incentive_value ?? 0),
      insured: e.insured ?? false,
      sort_order: e.sort_order != null ? String(e.sort_order) : '',
      hired_at: e.hired_at ?? '',
      slack_user_id: e.slack_user_id ?? '',
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error('이름은 필수입니다.'); return }
    const isPartTime = form.employee_type === 'part_time'
    const payload = {
      name: form.name.trim(),
      position: form.position || null,
      employee_type: form.employee_type,
      base_salary: isPartTime ? 0 : (parseFloat(form.base_salary) || 0),
      hourly_wage: isPartTime ? (parseInt(form.hourly_wage) || 0) : 0,
      work_days: isPartTime && form.work_days.length > 0
        ? WEEK_DAYS.filter((d) => form.work_days.includes(d)).join(',')
        : null,
      work_start_time: isPartTime ? (form.work_start_time || null) : null,
      work_end_time: isPartTime ? (form.work_end_time || null) : null,
      break_minutes: isPartTime ? (parseInt(form.break_minutes) || 0) : 0,
      wage_includes_holiday: isPartTime ? form.wage_includes_holiday : false,
      incentive_type: form.incentive_type || null,
      incentive_value: parseFloat(form.incentive_value) || 0,
      insured: form.insured,
      sort_order: form.sort_order ? parseInt(form.sort_order) : null,
      hired_at: form.hired_at || null,
      slack_user_id: form.slack_user_id.trim() || null,
    }

    const { error } = editing
      ? await supabase.from('employees').update(payload).eq('id', editing.id)
      : await supabase.from('employees').insert(payload)

    if (error) { toast.error(error.message); return }
    toast.success(editing ? '직원 정보가 수정되었습니다.' : '직원이 추가되었습니다.')
    setDialogOpen(false)
    load()
  }

  async function handleRetire(e: Employee) {
    const today = new Date().toISOString().slice(0, 10)
    const { error } = await supabase
      .from('employees')
      .update({ active: false, terminated_at: today })
      .eq('id', e.id)
    if (error) { toast.error(error.message); return }
    toast.success(`${e.name} 님을 퇴사 처리했습니다. 지난 급여 기록은 그대로 남습니다.`)
    load()
  }

  async function handleRehire(e: Employee) {
    const { error } = await supabase
      .from('employees')
      .update({ active: true, terminated_at: null })
      .eq('id', e.id)
    if (error) { toast.error(error.message); return }
    toast.success(`${e.name} 님을 재직 상태로 되돌렸습니다.`)
    load()
  }

  function renderRow(e: Employee, isRetired = false) {
    return (
      <TableRow key={e.id} className={isRetired ? 'opacity-60 bg-gray-50/50' : ''}>
        <TableCell className="text-center text-xs text-gray-400">{e.sort_order ?? '-'}</TableCell>
        <TableCell className="font-medium">{e.name}</TableCell>
        <TableCell>
          <Badge variant={e.employee_type === 'part_time' ? 'secondary' : 'outline'} className="text-xs">
            {e.employee_type === 'part_time' ? '아르바이트' : '정직원'}
          </Badge>
        </TableCell>
        <TableCell>{e.position ?? '-'}</TableCell>
        <TableCell className="text-right">
          {e.employee_type === 'part_time' ? (
            <div>
              <span className="text-purple-700">{formatKRW(e.hourly_wage ?? 0)}/h</span>
              {e.wage_includes_holiday && (
                <div className="text-xs text-blue-500">주휴 포함</div>
              )}
            </div>
          ) : formatKRW(e.base_salary)}
        </TableCell>
        <TableCell className="text-sm text-gray-500">
          {e.employee_type === 'part_time' ? (formatWorkSchedule(e) || '-') : '-'}
        </TableCell>
        <TableCell>
          {e.incentive_type ? (
            <Badge variant="outline">
              {e.incentive_type === 'percent' ? `${e.incentive_value}%` : formatKRW(e.incentive_value)}
            </Badge>
          ) : <span className="text-gray-300">-</span>}
        </TableCell>
        <TableCell className="text-center">
          {e.insured
            ? <Badge variant="outline" className="text-xs text-purple-600 border-purple-300">가입</Badge>
            : <span className="text-gray-300 text-xs">-</span>}
        </TableCell>
        <TableCell className="text-xs text-gray-500">
          {isRetired ? (e.terminated_at ?? '퇴사') : (e.hired_at ?? '-')}
        </TableCell>
        <TableCell>
          <div className="flex gap-1 justify-end">
            <Button size="sm" variant="ghost" onClick={() => openEdit(e)}><Pencil size={14} /></Button>
            {isRetired ? (
              <Button size="sm" variant="ghost" className="text-blue-600" onClick={() => handleRehire(e)}>
                <UserPlus size={14} />
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="text-gray-400 hover:text-red-500" onClick={() => handleRetire(e)}>
                <UserMinus size={14} />
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
    )
  }

  // ── 다이얼로그 미리보기 ──────────────────────────────────────
  // 저장 전에 휴게시간이 하루 소정근로시간을 얼마로 만드는지, 포괄시급이 최저임금을
  // 지키는지 그 자리에서 보여준다.
  const currentYear = new Date().getFullYear()
  const minWage = minimumWage(currentYear)
  const formBreak = parseInt(form.break_minutes) || 0
  const formWage = parseInt(form.hourly_wage) || 0
  const formBaseWage = Math.round(formWage / 1.2)
  const formSchedule = {
    days: form.work_days.join(','),
    start: form.work_start_time || null,
    end: form.work_end_time || null,
    breakMinutes: formBreak,
  }
  const formDailyHours = dailyWorkHours(formSchedule)
  const formSpanMinutes = dailySpanMinutes(formSchedule)
  const formBreakShortfall = formDailyHours !== null
    ? Math.max(0, requiredBreakMinutes(formDailyHours) - formBreak)
    : 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">직원 관리</h1>
          <p className="text-xs text-gray-400 mt-0.5">기본급·시급·인센티브 조건 등 잘 바뀌지 않는 값만 둡니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/payroll">
            <Button variant="outline" size="sm">
              이번 달 급여 처리<ArrowRight size={14} className="ml-1" />
            </Button>
          </Link>
          <Button onClick={openAdd} size="sm"><Plus size={16} className="mr-1" />직원 추가</Button>
        </div>
      </div>

      {/* 모바일 카드 */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="bg-white rounded-lg border text-center py-8 text-gray-400 text-sm">불러오는 중...</div>
        ) : employees.length === 0 ? (
          <div className="bg-white rounded-lg border text-center py-8 text-gray-400 text-sm">등록된 직원이 없습니다.</div>
        ) : employees.map((e) => (
          <div key={e.id} className="bg-white rounded-lg border p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-900">{e.name}</span>
                  {e.position && <span className="text-sm text-gray-500">{e.position}</span>}
                  <Badge variant={e.employee_type === 'part_time' ? 'secondary' : 'outline'} className="text-xs">
                    {e.employee_type === 'part_time' ? '아르바이트' : '정직원'}
                  </Badge>
                  {e.insured && (
                    <Badge variant="outline" className="text-xs text-purple-600 border-purple-300">4대보험</Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2 text-sm">
                  <div>
                    <div className="text-xs text-gray-400">{e.employee_type === 'part_time' ? '시급' : '기본급'}</div>
                    <div className="font-medium">
                      {e.employee_type === 'part_time'
                        ? `${formatKRW(e.hourly_wage ?? 0)}/h`
                        : formatKRW(e.base_salary)}
                    </div>
                    {e.employee_type === 'part_time' && e.wage_includes_holiday && (
                      <div className="text-xs text-blue-500">주휴 포함</div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs text-gray-400">인센티브</div>
                    <div>
                      {e.incentive_type ? (
                        <Badge variant="outline" className="text-xs">
                          {e.incentive_type === 'percent' ? `${e.incentive_value}%` : formatKRW(e.incentive_value)}
                        </Badge>
                      ) : <span className="text-gray-400">-</span>}
                    </div>
                  </div>
                </div>
                {e.employee_type === 'part_time' && formatWorkSchedule(e) && (
                  <div className="text-xs text-purple-600 mt-1">근무: {formatWorkSchedule(e)}</div>
                )}
                {e.hired_at && <div className="text-xs text-gray-400 mt-1">입사일: {e.hired_at}</div>}
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => openEdit(e)}><Pencil size={14} /></Button>
                <Button size="sm" variant="ghost" className="text-gray-400" onClick={() => handleRetire(e)}>
                  <UserMinus size={14} />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 데스크톱 테이블 */}
      <div className="hidden md:block bg-white rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 text-center">순번</TableHead>
              <TableHead>이름</TableHead>
              <TableHead>구분</TableHead>
              <TableHead>직책</TableHead>
              <TableHead className="text-right">기본급 / 시급</TableHead>
              <TableHead>근무일정</TableHead>
              <TableHead>인센티브</TableHead>
              <TableHead className="text-center">4대보험</TableHead>
              <TableHead>입사일</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={10} className="text-center py-8 text-gray-400">불러오는 중...</TableCell></TableRow>
            ) : employees.length === 0 ? (
              <TableRow><TableCell colSpan={10} className="text-center py-8 text-gray-400">등록된 직원이 없습니다.</TableCell></TableRow>
            ) : employees.map((e) => renderRow(e))}

            {showRetired && retired.length > 0 && (
              <>
                <TableRow>
                  <TableCell colSpan={10} className="bg-gray-50 py-1.5 px-3 text-xs text-gray-400 font-medium border-t">
                    퇴사 직원
                  </TableCell>
                </TableRow>
                {retired.map((e) => renderRow(e, true))}
              </>
            )}
          </TableBody>
        </Table>
      </div>

      {retired.length > 0 && (
        <button
          onClick={() => setShowRetired((v) => !v)}
          className="text-xs text-gray-400 hover:text-gray-700 transition-colors"
        >
          {showRetired ? '퇴사 직원 숨기기' : `퇴사 직원 ${retired.length}명 보기`}
        </button>
      )}

      <p className="text-xs text-gray-400 leading-relaxed">
        * 순번은 사업소득지급대장의 NO 순서입니다. 비워두면 이름 순으로 나갑니다.<br />
        * 4대보험 가입으로 표시된 직원만 급여 화면에서 회사부담분 입력칸이 열립니다.<br />
        * 아르바이트의 <strong>근무 요일·시간·휴게시간</strong>은 급여 화면에서 월 근무시간과 주휴수당을 산출하는 근거입니다.
        비워두면 근무시간을 직접 입력해야 하고, 주휴는 월 평균으로 근사 계산됩니다.<br />
        * 주민등록번호는 저장하지 않습니다 — 대장의 해당 칸은 비워서 내보냅니다.
      </p>

      {/* 추가 / 수정 다이얼로그 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing ? '직원 수정' : '직원 추가'}</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>이름 *</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>직책</Label>
                <Input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
              </div>
            </div>

            <div className="space-y-1">
              <Label>직원 구분</Label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm"
                value={form.employee_type}
                onChange={(e) => setForm({ ...form, employee_type: e.target.value as 'full_time' | 'part_time' })}
              >
                <option value="full_time">정직원 (월급)</option>
                <option value="part_time">아르바이트 (시급)</option>
              </select>
            </div>

            {form.employee_type === 'full_time' ? (
              <div className="space-y-1">
                <Label>기본급 (월, 세전)</Label>
                <CurrencyInput value={form.base_salary} onChange={(v) => setForm({ ...form, base_salary: v })} />
                <p className="text-xs text-gray-400">급여 화면에서 매달 이 값이 기본으로 채워집니다.</p>
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <Label>시급 (원/시간)</Label>
                  <CurrencyInput placeholder={`예: ${minWage.toLocaleString()}`} value={form.hourly_wage} onChange={(v) => setForm({ ...form, hourly_wage: v })} />
                  <p className="text-xs text-gray-400">{currentYear}년 최저임금: {minWage.toLocaleString()}원/h</p>
                </div>

                <label className="flex items-start gap-2 cursor-pointer select-none rounded-lg border p-3">
                  <input
                    type="checkbox"
                    checked={form.wage_includes_holiday}
                    onChange={(e) => setForm({ ...form, wage_includes_holiday: e.target.checked })}
                    className="rounded mt-0.5"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">시급에 주휴수당 포함 (포괄시급)</div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      체크하면 급여 화면에서 주휴수당을 따로 더하지 않습니다. 체크하지 않으면 주 15시간 이상일 때 주휴수당이 별도로 붙습니다.
                    </p>
                    {form.wage_includes_holiday && formWage > 0 && (
                      <div className={`mt-2 rounded-md px-2 py-1.5 text-xs ${
                        formBaseWage < minWage
                          ? 'bg-red-50 text-red-700 border border-red-200'
                          : 'bg-gray-50 text-gray-600'
                      }`}>
                        주 40시간 이하에서 주휴는 소정근로시간의 20%이므로{' '}
                        실질 기본시급은 <strong>{formatKRW(formBaseWage)}/h</strong>입니다.
                        {formBaseWage < minWage && (
                          <> {currentYear}년 최저임금 {minWage.toLocaleString()}원에 미달합니다 — 주휴 포함 시급은 최소 {formatKRW(Math.ceil(minWage * 1.2))}원이어야 합니다.</>
                        )}
                      </div>
                    )}
                  </div>
                </label>

                <div className="space-y-1">
                  <Label>근무 요일</Label>
                  <div className="flex gap-1">
                    {WEEK_DAYS.map((d) => {
                      const selected = form.work_days.includes(d)
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setForm({
                            ...form,
                            work_days: selected ? form.work_days.filter((v) => v !== d) : [...form.work_days, d],
                          })}
                          className={`w-9 h-9 rounded-md border text-sm font-medium transition-colors ${
                            selected
                              ? 'bg-purple-600 border-purple-600 text-white'
                              : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                          }`}
                        >
                          {d}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label>근무 시간</Label>
                  <div className="flex items-center gap-2">
                    <Input type="time" className="flex-1" value={form.work_start_time} onChange={(e) => setForm({ ...form, work_start_time: e.target.value })} />
                    <span className="text-gray-400">~</span>
                    <Input type="time" className="flex-1" value={form.work_end_time} onChange={(e) => setForm({ ...form, work_end_time: e.target.value })} />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label>휴게시간 (1일, 무급)</Label>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {BREAK_PRESETS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setForm({ ...form, break_minutes: String(m) })}
                        className={`h-9 px-3 rounded-md border text-sm font-medium transition-colors ${
                          (parseInt(form.break_minutes) || 0) === m
                            ? 'bg-purple-600 border-purple-600 text-white'
                            : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                        }`}
                      >
                        {m === 0 ? '없음' : m === 60 ? '점심 1시간' : `${m}분`}
                      </button>
                    ))}
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        className="h-9 w-20 text-right"
                        value={form.break_minutes}
                        onChange={(e) => setForm({ ...form, break_minutes: e.target.value })}
                      />
                      <span className="text-sm text-gray-400">분</span>
                    </div>
                  </div>

                  {formDailyHours !== null && formSpanMinutes !== null ? (
                    <div className="mt-1.5 rounded-md bg-gray-50 px-2.5 py-2 text-xs text-gray-600 space-y-1">
                      <div>
                        재실 {fmtHours(formSpanMinutes / 60)} − 휴게 {parseInt(form.break_minutes) || 0}분 ={' '}
                        <strong className="text-gray-900">1일 소정근로 {fmtHours(formDailyHours)}</strong>
                        {form.work_days.length > 0 && (
                          <> · 주 {fmtHours(formDailyHours * form.work_days.length)} ({form.work_days.length}일)</>
                        )}
                      </div>
                      {formBreakShortfall > 0 && (
                        <div className="text-amber-700">
                          근로기준법 제54조상 {formDailyHours >= 8 ? '8시간' : '4시간'} 근로에는{' '}
                          {requiredBreakMinutes(formDailyHours)}분 이상의 휴게시간이 필요합니다 — {formBreakShortfall}분 모자랍니다.
                        </div>
                      )}
                      {form.work_days.length > 0 && formDailyHours * form.work_days.length < 15 && (
                        <div className="text-gray-400">주 15시간 미만이라 주휴수당은 발생하지 않습니다.</div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400 mt-1">
                      근무 요일과 시간을 채우면 급여 화면에서 월 근무시간을 자동으로 산출할 수 있습니다.
                    </p>
                  )}
                </div>
              </>
            )}

            <div className="space-y-1">
              <Label>인센티브 방식</Label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm"
                value={form.incentive_type}
                onChange={(e) => setForm({ ...form, incentive_type: e.target.value as '' | 'percent' | 'fixed' })}
              >
                <option value="">없음</option>
                <option value="percent">정률 (%) — 담당 입금 공급가액 기준</option>
                <option value="fixed">정액 (원)</option>
              </select>
            </div>
            {form.incentive_type && (
              <div className="space-y-1">
                <Label>인센티브 값 ({form.incentive_type === 'percent' ? '%' : '원'})</Label>
                <Input type="number" value={form.incentive_value} onChange={(e) => setForm({ ...form, incentive_value: e.target.value })} />
              </div>
            )}

            <label className="flex items-start gap-2 cursor-pointer select-none rounded-lg border p-3">
              <input
                type="checkbox"
                checked={form.insured}
                onChange={(e) => setForm({ ...form, insured: e.target.checked })}
                className="rounded mt-0.5"
              />
              <div>
                <div className="text-sm font-medium">4대보험 가입</div>
                <p className="text-xs text-gray-400 mt-0.5">
                  체크하면 급여 화면에 회사부담분 입력칸이 열리고, 그 금액이 영업이익에서 차감됩니다.
                </p>
              </div>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>대장 순번</Label>
                <Input
                  type="number"
                  placeholder="비우면 이름 순"
                  value={form.sort_order}
                  onChange={(e) => setForm({ ...form, sort_order: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>입사일</Label>
                <Input type="date" value={form.hired_at} onChange={(e) => setForm({ ...form, hired_at: e.target.value })} />
              </div>
            </div>

            <div className="space-y-1">
              <Label>Slack 사용자 ID</Label>
              <Input
                placeholder="U01ABCDEF (비워두면 이름이 같을 때 자동 연결)"
                value={form.slack_user_id}
                onChange={(e) => setForm({ ...form, slack_user_id: e.target.value })}
              />
              <p className="text-xs text-gray-400">
                Slack에서 <code>/연차</code>로 신청·조회할 때 이 직원으로 인식됩니다.
                입사일이 없으면 연차가 계산되지 않으니 함께 입력해주세요.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>취소</Button>
            <Button onClick={handleSave}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
