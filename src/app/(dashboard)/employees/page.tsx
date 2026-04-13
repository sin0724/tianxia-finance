'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from 'sonner'
import { Plus, Pencil, Check } from 'lucide-react'
import { formatKRW } from '@/lib/calculations/settlement'
import type { Employee, MonthlyPayroll } from '@/types/database'

type PayrollRow = MonthlyPayroll & { employees: { name: string } | null }

type PayFormEntry = {
  base_salary: string
  deductions: string
  net_pay: string
  work_hours: string
  paid_at: string
}

export default function EmployeesPage() {
  const supabase = createClient()
  const now = new Date()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Employee | null>(null)
  const [form, setForm] = useState({
    name: '',
    position: '',
    employee_type: 'full_time' as 'full_time' | 'part_time',
    base_salary: '',
    hourly_wage: '',
    incentive_type: '' as '' | 'percent' | 'fixed',
    incentive_value: '',
    hired_at: '',
  })

  // 월별 급여
  const [payYear, setPayYear] = useState(now.getFullYear())
  const [payMonth, setPayMonth] = useState(now.getMonth() + 1)
  const [payrollRows, setPayrollRows] = useState<PayrollRow[]>([])
  const [payForms, setPayForms] = useState<Record<string, PayFormEntry>>({})

  async function load() {
    const { data } = await supabase.from('employees').select('*').eq('active', true).order('name')
    setEmployees(data ?? [])
    setLoading(false)
  }

  async function loadPayroll() {
    const { data } = await supabase
      .from('monthly_payroll')
      .select('*, employees(name)')
      .eq('year', payYear)
      .eq('month', payMonth)
    setPayrollRows((data as unknown as PayrollRow[]) ?? [])

    const { data: emps } = await supabase.from('employees').select('*').eq('active', true).order('name')
    const empList = emps ?? []
    const existingMap: Record<string, PayrollRow> = {}
    for (const r of (data as unknown as PayrollRow[]) ?? []) {
      if (r.employee_id) existingMap[r.employee_id] = r
    }

    const forms: Record<string, PayFormEntry> = {}
    for (const emp of empList) {
      const existing = existingMap[emp.id]
      if (existing) {
        forms[emp.id] = {
          base_salary: String(existing.base_salary),
          deductions: String(existing.deductions),
          net_pay: String(existing.net_pay),
          work_hours: String(existing.work_hours ?? 0),
          paid_at: existing.paid_at ?? '',
        }
      } else if (emp.employee_type === 'part_time') {
        forms[emp.id] = {
          base_salary: '0',
          deductions: '0',
          net_pay: '0',
          work_hours: '0',
          paid_at: '',
        }
      } else {
        forms[emp.id] = {
          base_salary: String(emp.base_salary),
          deductions: '0',
          net_pay: String(emp.base_salary),
          work_hours: '0',
          paid_at: '',
        }
      }
    }
    setPayForms(forms)
    setEmployees(empList)
    setLoading(false)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { loadPayroll() }, [payYear, payMonth])

  function openAdd() {
    setEditing(null)
    setForm({ name: '', position: '', employee_type: 'full_time', base_salary: '', hourly_wage: '', incentive_type: '', incentive_value: '', hired_at: '' })
    setDialogOpen(true)
  }

  function openEdit(e: Employee) {
    setEditing(e)
    setForm({
      name: e.name,
      position: e.position ?? '',
      employee_type: e.employee_type ?? 'full_time',
      base_salary: String(e.base_salary),
      hourly_wage: String(e.hourly_wage ?? 0),
      incentive_type: e.incentive_type ?? '',
      incentive_value: String(e.incentive_value),
      hired_at: e.hired_at ?? '',
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!form.name) { toast.error('이름은 필수입니다.'); return }
    const payload = {
      name: form.name,
      position: form.position || null,
      employee_type: form.employee_type,
      base_salary: form.employee_type === 'full_time' ? (parseFloat(form.base_salary) || 0) : 0,
      hourly_wage: form.employee_type === 'part_time' ? (parseInt(form.hourly_wage) || 0) : 0,
      incentive_type: form.incentive_type || null,
      incentive_value: parseFloat(form.incentive_value) || 0,
      hired_at: form.hired_at || null,
    }
    if (editing) {
      const { error } = await supabase.from('employees').update(payload).eq('id', editing.id)
      if (error) { toast.error(error.message); return }
      toast.success('직원 정보가 수정되었습니다.')
    } else {
      const { error } = await supabase.from('employees').insert(payload)
      if (error) { toast.error(error.message); return }
      toast.success('직원이 추가되었습니다.')
    }
    setDialogOpen(false)
    loadPayroll()
  }

  async function handleDeactivate(id: string) {
    await supabase.from('employees').update({ active: false }).eq('id', id)
    toast.success('직원이 비활성화되었습니다.')
    loadPayroll()
  }

  function updatePayForm(empId: string, field: keyof PayFormEntry, value: string) {
    setPayForms((prev) => {
      const emp = employees.find((e) => e.id === empId)
      const row = { ...prev[empId], [field]: value }

      if (emp?.employee_type === 'part_time') {
        // 아르바이트: 시간수 변경 시 기본급 자동 계산
        const hours = parseFloat(field === 'work_hours' ? value : row.work_hours) || 0
        const wage = emp.hourly_wage ?? 0
        const computed = Math.round(hours * wage)
        row.base_salary = String(computed)
        const ded = parseFloat(row.deductions) || 0
        row.net_pay = String(Math.max(0, computed - ded))
      } else {
        // 정직원: 기본급 또는 공제액 변경 시 실수령액 자동 계산
        if (field === 'base_salary' || field === 'deductions') {
          const base = parseFloat(field === 'base_salary' ? value : row.base_salary) || 0
          const ded = parseFloat(field === 'deductions' ? value : row.deductions) || 0
          row.net_pay = String(Math.max(0, base - ded))
        }
      }

      return { ...prev, [empId]: row }
    })
  }

  async function savePayroll(empId: string) {
    const f = payForms[empId]
    if (!f) return
    const base = parseFloat(f.base_salary) || 0
    const ded = parseFloat(f.deductions) || 0
    const net = parseFloat(f.net_pay) || 0
    const hours = parseFloat(f.work_hours) || 0

    const existing = payrollRows.find((r) => r.employee_id === empId)
    if (existing) {
      const { error } = await supabase.from('monthly_payroll').update({
        base_salary: base, deductions: ded, net_pay: net, work_hours: hours, paid_at: f.paid_at || null,
      }).eq('id', existing.id)
      if (error) { toast.error('수정 실패'); return }
    } else {
      const { error } = await supabase.from('monthly_payroll').insert({
        year: payYear, month: payMonth, employee_id: empId,
        base_salary: base, deductions: ded, net_pay: net, work_hours: hours, paid_at: f.paid_at || null,
      })
      if (error) { toast.error('저장 실패'); return }
    }
    toast.success('급여가 저장되었습니다.')
    loadPayroll()
  }

  async function saveAllPayroll() {
    for (const emp of employees) {
      await savePayroll(emp.id)
    }
    toast.success(`${payMonth}월 급여가 모두 저장되었습니다.`)
  }

  const payrollMap: Record<string, boolean> = {}
  for (const r of payrollRows) {
    if (r.employee_id) payrollMap[r.employee_id] = true
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">직원 / 급여 관리</h1>
        <Button onClick={openAdd}><Plus size={16} className="mr-1" />직원 추가</Button>
      </div>

      {/* 직원 목록 - 모바일 카드 */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="bg-white rounded-lg border text-center py-8 text-gray-400 text-sm">불러오는 중...</div>
        ) : employees.length === 0 ? (
          <div className="bg-white rounded-lg border text-center py-8 text-gray-400 text-sm">등록된 직원이 없습니다.</div>
        ) : employees.map((e) => (
          <div key={e.id} className="bg-white rounded-lg border p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-900">{e.name}</span>
                  {e.position && <span className="text-sm text-gray-500">{e.position}</span>}
                  <Badge variant={e.employee_type === 'part_time' ? 'secondary' : 'outline'} className="text-xs">
                    {e.employee_type === 'part_time' ? '아르바이트' : '정직원'}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2 text-sm">
                  {e.employee_type === 'part_time' ? (
                    <div>
                      <div className="text-xs text-gray-400">시급</div>
                      <div className="font-medium">{formatKRW(e.hourly_wage ?? 0)}/h</div>
                    </div>
                  ) : (
                    <div>
                      <div className="text-xs text-gray-400">기본급</div>
                      <div className="font-medium">{formatKRW(e.base_salary)}</div>
                    </div>
                  )}
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
                {e.hired_at && <div className="text-xs text-gray-400 mt-1">입사일: {e.hired_at}</div>}
              </div>
              <div className="flex gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => openEdit(e)}><Pencil size={14} /></Button>
                <Button size="sm" variant="ghost" className="text-red-500" onClick={() => handleDeactivate(e.id)}>삭제</Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 직원 목록 - 데스크톱 테이블 */}
      <div className="hidden md:block bg-white rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>이름</TableHead>
              <TableHead>구분</TableHead>
              <TableHead>직책</TableHead>
              <TableHead className="text-right">기본급 / 시급</TableHead>
              <TableHead>인센티브</TableHead>
              <TableHead>입사일</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400">불러오는 중...</TableCell></TableRow>
            ) : employees.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400">등록된 직원이 없습니다.</TableCell></TableRow>
            ) : employees.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="font-medium">{e.name}</TableCell>
                <TableCell>
                  <Badge variant={e.employee_type === 'part_time' ? 'secondary' : 'outline'} className="text-xs">
                    {e.employee_type === 'part_time' ? '아르바이트' : '정직원'}
                  </Badge>
                </TableCell>
                <TableCell>{e.position ?? '-'}</TableCell>
                <TableCell className="text-right">
                  {e.employee_type === 'part_time'
                    ? <span className="text-purple-700">{formatKRW(e.hourly_wage ?? 0)}/h</span>
                    : formatKRW(e.base_salary)}
                </TableCell>
                <TableCell>
                  {e.incentive_type ? (
                    <Badge variant="outline">
                      {e.incentive_type === 'percent' ? `${e.incentive_value}%` : formatKRW(e.incentive_value)}
                    </Badge>
                  ) : '-'}
                </TableCell>
                <TableCell>{e.hired_at ?? '-'}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(e)}><Pencil size={14} /></Button>
                    <Button size="sm" variant="ghost" className="text-red-500" onClick={() => handleDeactivate(e.id)}>삭제</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* 월별 급여 입력 */}
      <div className="bg-white rounded-lg border">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b">
          <h2 className="font-semibold text-gray-800">월별 급여 입력</h2>
          <div className="flex items-center gap-2">
            <select className="border rounded-md px-2 py-1.5 text-sm" value={payYear} onChange={(e) => setPayYear(Number(e.target.value))}>
              {[2023, 2024, 2025, 2026].map((y) => <option key={y} value={y}>{y}년</option>)}
            </select>
            <select className="border rounded-md px-2 py-1.5 text-sm" value={payMonth} onChange={(e) => setPayMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}월</option>)}
            </select>
            <Button size="sm" onClick={saveAllPayroll}>전체 저장</Button>
          </div>
        </div>

        {employees.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">등록된 직원이 없습니다.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>직원</TableHead>
                <TableHead className="text-right">근무시간 / 기본급</TableHead>
                <TableHead className="text-right">공제액</TableHead>
                <TableHead className="text-right">실수령액</TableHead>
                <TableHead>지급일</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {employees.map((emp) => {
                const f = payForms[emp.id] ?? {
                  base_salary: emp.employee_type === 'part_time' ? '0' : String(emp.base_salary),
                  deductions: '0',
                  net_pay: emp.employee_type === 'part_time' ? '0' : String(emp.base_salary),
                  work_hours: '0',
                  paid_at: '',
                }
                const isSaved = payrollMap[emp.id]
                const isPartTime = emp.employee_type === 'part_time'

                return (
                  <TableRow key={emp.id} className={isSaved ? 'bg-green-50/40' : ''}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-1.5">
                        {emp.name}
                        {isSaved && <Check size={13} className="text-green-500" />}
                        {isPartTime && (
                          <Badge variant="secondary" className="text-xs py-0">
                            {formatKRW(emp.hourly_wage ?? 0)}/h
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {isPartTime ? (
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            className="h-8 text-sm text-right w-20"
                            placeholder="시간"
                            value={f.work_hours}
                            onChange={(e) => updatePayForm(emp.id, 'work_hours', e.target.value)}
                          />
                          <span className="text-xs text-gray-400 whitespace-nowrap">h</span>
                          <span className="text-xs text-gray-500 whitespace-nowrap">
                            = {formatKRW(parseFloat(f.base_salary) || 0)}
                          </span>
                        </div>
                      ) : (
                        <Input
                          type="number"
                          className="h-8 text-sm text-right"
                          value={f.base_salary}
                          onChange={(e) => updatePayForm(emp.id, 'base_salary', e.target.value)}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        className="h-8 text-sm text-right"
                        value={f.deductions}
                        onChange={(e) => updatePayForm(emp.id, 'deductions', e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        className="h-8 text-sm text-right"
                        value={f.net_pay}
                        onChange={(e) => updatePayForm(emp.id, 'net_pay', e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="date"
                        className="h-8 text-sm"
                        value={f.paid_at}
                        onChange={(e) => updatePayForm(emp.id, 'paid_at', e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant={isSaved ? 'outline' : 'default'} onClick={() => savePayroll(emp.id)}>
                        {isSaved ? '수정' : '저장'}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* 직원 추가/수정 다이얼로그 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? '직원 수정' : '직원 추가'}</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1"><Label>이름 *</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="space-y-1"><Label>직책</Label><Input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} /></div>
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
              <div className="space-y-1"><Label>기본급 (월)</Label><Input type="number" value={form.base_salary} onChange={(e) => setForm({ ...form, base_salary: e.target.value })} /></div>
            ) : (
              <div className="space-y-1">
                <Label>시급 (원/시간)</Label>
                <Input type="number" placeholder="예: 10030" value={form.hourly_wage} onChange={(e) => setForm({ ...form, hourly_wage: e.target.value })} />
                <p className="text-xs text-gray-400">2025년 최저임금: 10,030원/h</p>
              </div>
            )}
            <div className="space-y-1">
              <Label>인센티브 방식</Label>
              <select className="w-full border rounded-md px-3 py-2 text-sm" value={form.incentive_type} onChange={(e) => setForm({ ...form, incentive_type: e.target.value as '' | 'percent' | 'fixed' })}>
                <option value="">없음</option>
                <option value="percent">정률 (%)</option>
                <option value="fixed">정액 (원)</option>
              </select>
            </div>
            {form.incentive_type && (
              <div className="space-y-1">
                <Label>인센티브 값 ({form.incentive_type === 'percent' ? '%' : '원'})</Label>
                <Input type="number" value={form.incentive_value} onChange={(e) => setForm({ ...form, incentive_value: e.target.value })} />
              </div>
            )}
            <div className="space-y-1"><Label>입사일</Label><Input type="date" value={form.hired_at} onChange={(e) => setForm({ ...form, hired_at: e.target.value })} /></div>
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
