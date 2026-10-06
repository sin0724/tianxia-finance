'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/lib/toast'
import { refreshBadges } from '@/lib/payments/unmatched'
import { getAllLeaveBalances, type LeaveBalance } from '@/lib/leave/balance'
import { LEAVE_TYPE_LABEL, periodLabel, promotionDate, todayISO } from '@/lib/leave/policy'
import { formatRange } from '@/lib/leave/calc'
import type { LeaveRequest, CompanyHoliday, LeaveAbsence, LeavePromotion } from '@/types/database'
import { Check, X, Trash2, Plus, CalendarDays, Link2, Pencil, Undo2, BellRing } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

type RequestRow = LeaveRequest & { employees: { name: string } | null }
type AbsenceRow = LeaveAbsence & { employees: { name: string } | null }

const STATUS_META: Record<string, { label: string; className: string }> = {
  pending:   { label: '승인 대기', className: 'bg-amber-100 text-amber-800' },
  approved:  { label: '승인',      className: 'bg-emerald-100 text-emerald-800' },
  rejected:  { label: '반려',      className: 'bg-red-100 text-red-700' },
  cancelled: { label: '취소',      className: 'bg-gray-100 text-gray-600' },
}

export default function LeavePage() {
  const supabase = useMemo(() => createClient(), [])
  const [tab, setTab] = useState('pending')
  const [loading, setLoading] = useState(true)

  const [requests, setRequests] = useState<RequestRow[]>([])
  const [balances, setBalances] = useState<LeaveBalance[]>([])
  const [holidays, setHolidays] = useState<CompanyHoliday[]>([])
  const [historyFilter, setHistoryFilter] = useState<'all' | 'approved' | 'rejected' | 'cancelled'>('all')

  const [rejectTarget, setRejectTarget] = useState<RequestRow | null>(null)
  const [rejectMemo, setRejectMemo] = useState('')
  const [cancelTarget, setCancelTarget] = useState<RequestRow | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [grantTarget, setGrantTarget] = useState<LeaveBalance | null>(null)
  const [grantForm, setGrantForm] = useState({ granted: '0', carried: '0', adjustment: '0', memo: '' })

  const [holidayForm, setHolidayForm] = useState({ date: '', name: '' })

  const [absences, setAbsences] = useState<AbsenceRow[]>([])
  const [promotions, setPromotions] = useState<LeavePromotion[]>([])
  const [fullTimers, setFullTimers] = useState<{ id: string; name: string }[]>([])
  const [absenceForm, setAbsenceForm] = useState({ employeeId: '', date: '', days: '1', memo: '' })
  const [promoting, setPromoting] = useState(false)

  const load = useCallback(async () => {
    const [{ data: reqs }, bals, { data: hols }, { data: abs }, { data: promos }, { data: emps }] = await Promise.all([
      supabase
        .from('leave_requests')
        .select('*, employees(name)')
        .order('start_date', { ascending: false }),
      getAllLeaveBalances(supabase),
      supabase.from('company_holidays').select('*').order('holiday_date'),
      supabase
        .from('leave_absences')
        .select('*, employees(name)')
        .order('absence_date', { ascending: false }),
      supabase.from('leave_promotions').select('*'),
      supabase
        .from('employees')
        .select('id, name')
        .eq('active', true)
        .eq('employee_type', 'full_time')
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('name'),
    ])
    setRequests((reqs as unknown as RequestRow[]) ?? [])
    setBalances(bals)
    setHolidays(hols ?? [])
    setAbsences((abs as unknown as AbsenceRow[]) ?? [])
    setPromotions(promos ?? [])
    setFullTimers(emps ?? [])
    setLoading(false)
    refreshBadges()
  }, [supabase])

  useEffect(() => { load() }, [load])

  const pending = requests.filter((r) => r.status === 'pending')
  const history = requests.filter((r) =>
    r.status !== 'pending' && (historyFilter === 'all' || r.status === historyFilter),
  )

  async function review(req: RequestRow, action: 'approve' | 'reject' | 'cancel', memo?: string | null) {
    setBusyId(req.id)
    try {
      const res = await fetch('/api/leave/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: req.id, action, memo: memo ?? null }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? '처리에 실패했습니다.'); return }
      toast.success(
        action === 'approve' ? '연차를 승인했습니다.'
        : action === 'reject' ? '연차를 반려했습니다.'
        : '연차를 취소했습니다. 캘린더 일정도 함께 삭제됩니다.',
      )
      await load()
    } catch {
      toast.error('서버와 통신하지 못했습니다.')
    } finally {
      setBusyId(null)
    }
  }

  function openGrant(b: LeaveBalance) {
    setGrantTarget(b)
    setGrantForm({
      granted: String(b.granted),
      carried: String(b.carriedOver),
      adjustment: String(b.adjustment),
      memo: '',
    })
  }

  async function saveGrant() {
    if (!grantTarget?.period) return
    const { error } = await supabase.from('leave_grants').upsert({
      employee_id: grantTarget.employeeId,
      period_start: grantTarget.period.start,
      period_end: grantTarget.period.end,
      granted_days: Number(grantForm.granted) || 0,
      carried_over: Number(grantForm.carried) || 0,
      adjustment: Number(grantForm.adjustment) || 0,
      memo: grantForm.memo || null,
    }, { onConflict: 'employee_id,period_start' })

    if (error) { toast.error(error.message); return }
    toast.success('부여 일수를 저장했습니다.')
    setGrantTarget(null)
    load()
  }

  async function addHoliday() {
    if (!holidayForm.date || !holidayForm.name) { toast.error('날짜와 이름을 입력해주세요.'); return }
    const { error } = await supabase
      .from('company_holidays')
      .insert({ holiday_date: holidayForm.date, name: holidayForm.name })
    if (error) { toast.error(error.message); return }
    setHolidayForm({ date: '', name: '' })
    toast.success('공휴일을 추가했습니다.')
    load()
  }

  async function addAbsence() {
    if (!absenceForm.employeeId || !absenceForm.date) { toast.error('직원과 날짜를 선택해주세요.'); return }
    const { error } = await supabase.from('leave_absences').insert({
      employee_id: absenceForm.employeeId,
      absence_date: absenceForm.date,
      days: Number(absenceForm.days),
      memo: absenceForm.memo || null,
    })
    if (error) {
      toast.error(error.code === '23505' ? '이미 그날 결근이 기록되어 있습니다.' : error.message)
      return
    }
    setAbsenceForm({ ...absenceForm, date: '', memo: '' })
    toast.success('결근을 기록했습니다. 연차 발생 일수에 반영됩니다.')
    load()
  }

  async function deleteAbsence(id: string) {
    const { error } = await supabase.from('leave_absences').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    load()
  }

  /** 오늘 촉진 대상자에게 DM 발송 — 매일 cron 이 하는 일을 지금 바로 돌린다 */
  async function runPromotion() {
    setPromoting(true)
    try {
      const res = await fetch('/api/leave/promotion', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? '발송에 실패했습니다.'); return }
      const sent = (data.sent ?? []) as { employeeName: string; stage: number }[]
      toast.success(sent.length === 0
        ? '오늘 새로 보낼 촉진 안내가 없습니다.'
        : `촉진 안내 ${sent.length}건 발송: ${sent.map((r) => `${r.employeeName}(${r.stage}차)`).join(', ')}`)
      load()
    } catch {
      toast.error('서버와 통신하지 못했습니다.')
    } finally {
      setPromoting(false)
    }
  }

  /** 현황 표의 촉진 칸 — 보낸 차수는 날짜와 계획 제출 여부, 아직이면 예정일 */
  function promotionSummary(b: LeaveBalance) {
    const period = b.period
    if (!period) return '-'
    const mine = promotions.filter((p) => p.employee_id === b.employeeId && p.period_start === period.start)
    return ([1, 2] as const).map((n) => {
      const sent = mine.find((p) => p.stage === n)
      if (!sent) return <div key={n} className="text-gray-400">{n}차 {promotionDate(period, n)} 예정</div>
      return (
        <div key={n} className={sent.dm_sent ? 'text-gray-700' : 'text-red-600'}>
          {n}차 {sent.notified_at.slice(0, 10)} {sent.dm_sent ? '발송' : 'DM 실패'}
          {n === 1 && (sent.plan_submitted_at
            ? <span className="text-emerald-600"> · 계획 제출</span>
            : <span className="text-amber-600"> · 계획 미제출</span>)}
        </div>
      )
    })
  }

  async function deleteHoliday(date: string) {
    const { error } = await supabase.from('company_holidays').delete().eq('holiday_date', date)
    if (error) { toast.error(error.message); return }
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">연차 관리</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            직원은 Slack에서 <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">/연차</code> 로 신청하고 잔여를 확인합니다.
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as string)}>
        <TabsList>
          <TabsTrigger value="pending">
            승인 대기{pending.length > 0 && ` (${pending.length})`}
          </TabsTrigger>
          <TabsTrigger value="balance">연차 현황</TabsTrigger>
          <TabsTrigger value="history">전체 내역</TabsTrigger>
          <TabsTrigger value="absences">결근 기록</TabsTrigger>
          <TabsTrigger value="holidays">공휴일</TabsTrigger>
        </TabsList>

        {/* ── 승인 대기 ───────────────────────────────────────── */}
        <TabsContent value="pending">
          {loading ? (
            <div className="bg-white rounded-lg border text-center py-10 text-gray-400 text-sm">불러오는 중...</div>
          ) : pending.length === 0 ? (
            <div className="bg-white rounded-lg border text-center py-10 text-gray-400 text-sm">
              승인을 기다리는 연차 신청이 없습니다.
            </div>
          ) : (
            <div className="space-y-2">
              {pending.map((r) => {
                const bal = balances.find((b) => b.employeeId === r.employee_id)
                const after = bal ? bal.total - bal.used - Number(r.days) : null
                return (
                  <div key={r.id} className="bg-white rounded-lg border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-gray-900">{r.employees?.name ?? '(삭제된 직원)'}</span>
                          <Badge className="bg-blue-100 text-blue-800">{LEAVE_TYPE_LABEL[r.leave_type]}</Badge>
                          <span className="text-sm text-gray-600">
                            {formatRange(r.start_date, r.end_date)} · <b>{r.days}일</b>
                          </span>
                        </div>
                        {r.reason && <div className="text-sm text-gray-500 mt-1">사유: {r.reason}</div>}
                        {bal && (
                          <div className="text-xs text-gray-400 mt-1">
                            현재 잔여 {bal.remaining}일 · 승인 시 {after}일 남음 (총 {bal.total}일)
                            {after !== null && after < 0 && (
                              <span className="text-red-500 font-medium"> — 잔여 초과</span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Button
                          size="sm"
                          disabled={busyId === r.id}
                          onClick={() => review(r, 'approve')}
                        >
                          <Check size={14} className="mr-1" />승인
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === r.id}
                          className="text-red-600 hover:text-red-700"
                          onClick={() => { setRejectTarget(r); setRejectMemo('') }}
                        >
                          <X size={14} className="mr-1" />반려
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </TabsContent>

        {/* ── 연차 현황 ───────────────────────────────────────── */}
        <TabsContent value="balance">
          <div className="bg-white rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>직원</TableHead>
                  <TableHead>연차연도</TableHead>
                  <TableHead className="text-right">발생</TableHead>
                  <TableHead className="text-right">이월</TableHead>
                  <TableHead className="text-right">사용</TableHead>
                  <TableHead className="text-right">대기</TableHead>
                  <TableHead className="text-right">잔여</TableHead>
                  <TableHead>소멸일</TableHead>
                  <TableHead>사용 촉진</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={10} className="text-center py-8 text-gray-400">불러오는 중...</TableCell></TableRow>
                ) : balances.length === 0 ? (
                  <TableRow><TableCell colSpan={10} className="text-center py-8 text-gray-400">재직 중인 정직원이 없습니다. (아르바이트는 연차가 발생하지 않습니다)</TableCell></TableRow>
                ) : balances.map((b) => (
                  <TableRow key={b.employeeId}>
                    <TableCell className="font-medium">
                      {b.employeeName}
                      {!b.hiredAt && (
                        <div className="text-xs text-red-500">입사일 미등록 — 직원 관리에서 입력 필요</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-gray-500">
                      {b.period ? periodLabel(b.period) : '-'}
                      {b.nextAccrualAt && (
                        <div className="text-xs text-blue-600">다음 발생 {b.nextAccrualAt} (개근 시 +1일)</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {b.granted}
                      {b.isManualGrant && <span className="ml-1 text-[10px] text-gray-400">수동</span>}
                      <div className="text-[11px] text-gray-400 max-w-[14rem] ml-auto">{b.basis}</div>
                    </TableCell>
                    <TableCell className="text-right text-gray-500">{b.carriedOver || '-'}</TableCell>
                    <TableCell className="text-right">{b.used}</TableCell>
                    <TableCell className="text-right text-amber-600">{b.pending || '-'}</TableCell>
                    <TableCell className={`text-right font-semibold ${b.remaining < 0 ? 'text-red-600' : ''}`}>
                      {b.remaining}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{b.expiresAt ?? '-'}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{promotionSummary(b)}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" disabled={!b.period} onClick={() => openGrant(b)}>
                        <Pencil size={14} />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-wrap items-start justify-between gap-2 mt-2">
            <p className="text-xs text-gray-400 leading-relaxed">
              <Link2 size={11} className="inline mr-1" />
              입사 첫 해에는 1개월 개근마다 1일(최대 11일), 1년 이상은 직전 연도 출근율 80% 이상이면 15일에
              최초 1년 초과 근속 2년마다 1일씩 가산(최대 25일)됩니다. 출근율은 &quot;결근 기록&quot; 탭 기준입니다.
              연필 버튼으로 직접 지정하면 그 값이 우선합니다.
              <br />
              미사용 연차는 소멸일에 사라집니다. 소멸 6개월 전 1차(사용 계획 제출 요청), 2개월 전 2차 사용 촉진 안내가
              Slack DM 으로 자동 발송됩니다.
            </p>
            <Button size="sm" variant="outline" disabled={promoting} onClick={runPromotion}>
              <BellRing size={14} className="mr-1" />{promoting ? '확인 중...' : '촉진 알림 확인'}
            </Button>
          </div>
        </TabsContent>

        {/* ── 전체 내역 ───────────────────────────────────────── */}
        <TabsContent value="history">
          <div className="flex gap-1 mb-2 flex-wrap">
            {([
              ['all', '전체'], ['approved', '승인'], ['rejected', '반려'], ['cancelled', '취소'],
            ] as const).map(([key, label]) => (
              <Button
                key={key}
                size="sm"
                variant={historyFilter === key ? 'default' : 'outline'}
                onClick={() => setHistoryFilter(key)}
              >
                {label}
              </Button>
            ))}
          </div>

          <div className="bg-white rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>직원</TableHead>
                  <TableHead>종류</TableHead>
                  <TableHead>기간</TableHead>
                  <TableHead className="text-right">일수</TableHead>
                  <TableHead>사유</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>처리</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center py-8 text-gray-400">내역이 없습니다.</TableCell></TableRow>
                ) : history.map((r) => {
                  const meta = STATUS_META[r.status]
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.employees?.name ?? '-'}</TableCell>
                      <TableCell>{LEAVE_TYPE_LABEL[r.leave_type]}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatRange(r.start_date, r.end_date)}</TableCell>
                      <TableCell className="text-right">{r.days}</TableCell>
                      <TableCell className="max-w-[16rem] truncate">{r.reason ?? '-'}</TableCell>
                      <TableCell><Badge className={meta.className}>{meta.label}</Badge></TableCell>
                      <TableCell className="text-xs text-gray-500">
                        {r.reviewed_by ?? '-'}
                        {r.review_memo && <div className="text-gray-400">{r.review_memo}</div>}
                      </TableCell>
                      <TableCell className="text-right">
                        {/* 승인된 건은 되돌릴 수 있어야 한다 — 취소하면 잔여가 복구되고 캘린더 일정도 지워진다 */}
                        {r.status === 'approved' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-gray-400 hover:text-red-600"
                            disabled={busyId === r.id}
                            onClick={() => setCancelTarget(r)}
                          >
                            <Undo2 size={14} className="mr-1" />취소
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* ── 결근 기록 ───────────────────────────────────────── */}
        <TabsContent value="absences">
          <div className="bg-white rounded-lg border p-4 space-y-3">
            <p className="text-sm text-gray-500">
              정직원의 결근을 기록하면 연차 발생에 반영됩니다. 입사 첫 해에는 결근이 있는 달의 연차가 생기지 않고,
              1년 이상은 직전 연도 출근율이 80% 미만이면 15일 대신 개근한 달 수만큼만 발생합니다.
              승인된 연차·병가·특별휴가와 공휴일은 결근이 아니므로 넣지 않습니다.
            </p>
            <div className="flex flex-wrap gap-2 items-end">
              <div className="space-y-1">
                <Label className="text-xs">직원</Label>
                <select
                  className="h-9 w-40 rounded-md border px-2 text-sm bg-white"
                  value={absenceForm.employeeId}
                  onChange={(e) => setAbsenceForm({ ...absenceForm, employeeId: e.target.value })}
                >
                  <option value="">선택</option>
                  {fullTimers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">날짜</Label>
                <Input
                  type="date"
                  className="w-40"
                  value={absenceForm.date}
                  onChange={(e) => setAbsenceForm({ ...absenceForm, date: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">구분</Label>
                <select
                  className="h-9 w-28 rounded-md border px-2 text-sm bg-white"
                  value={absenceForm.days}
                  onChange={(e) => setAbsenceForm({ ...absenceForm, days: e.target.value })}
                >
                  <option value="1">결근 (1일)</option>
                  <option value="0.5">반일 결근</option>
                </select>
              </div>
              <div className="space-y-1 flex-1 min-w-40">
                <Label className="text-xs">메모</Label>
                <Input
                  placeholder="예) 무단 결근"
                  value={absenceForm.memo}
                  onChange={(e) => setAbsenceForm({ ...absenceForm, memo: e.target.value })}
                />
              </div>
              <Button onClick={addAbsence}><Plus size={14} className="mr-1" />기록</Button>
            </div>
          </div>

          <div className="bg-white rounded-lg border mt-2 divide-y">
            {absences.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">기록된 결근이 없습니다. (기록이 없으면 개근으로 봅니다)</div>
            ) : absences.map((a) => (
              <div key={a.id} className="flex items-center justify-between px-4 py-2.5">
                <div className="flex items-center gap-3 text-sm flex-wrap">
                  <CalendarDays size={14} className="text-gray-400" />
                  <span className="text-gray-900">{a.absence_date}</span>
                  <span className="font-medium">{a.employees?.name ?? '-'}</span>
                  <Badge className="bg-red-50 text-red-700">{Number(a.days) === 0.5 ? '반일 결근' : '결근'}</Badge>
                  {a.memo && <span className="text-gray-500">{a.memo}</span>}
                </div>
                <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-600"
                  onClick={() => deleteAbsence(a.id)}>
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
        </TabsContent>

        {/* ── 공휴일 ─────────────────────────────────────────── */}
        <TabsContent value="holidays">
          <div className="bg-white rounded-lg border p-4 space-y-3">
            <p className="text-sm text-gray-500">
              여기 등록된 날짜는 연차 일수 계산에서 제외됩니다. 주말은 자동으로 제외되므로 따로 넣지 않아도 됩니다.
            </p>
            <div className="flex flex-wrap gap-2 items-end">
              <div className="space-y-1">
                <Label className="text-xs">날짜</Label>
                <Input
                  type="date"
                  className="w-40"
                  value={holidayForm.date}
                  onChange={(e) => setHolidayForm({ ...holidayForm, date: e.target.value })}
                />
              </div>
              <div className="space-y-1 flex-1 min-w-40">
                <Label className="text-xs">이름</Label>
                <Input
                  placeholder="예) 창립기념일"
                  value={holidayForm.name}
                  onChange={(e) => setHolidayForm({ ...holidayForm, name: e.target.value })}
                />
              </div>
              <Button onClick={addHoliday}><Plus size={14} className="mr-1" />추가</Button>
            </div>
          </div>

          <div className="bg-white rounded-lg border mt-2 divide-y">
            {holidays.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">등록된 공휴일이 없습니다.</div>
            ) : holidays.map((h) => (
              <div key={h.holiday_date} className="flex items-center justify-between px-4 py-2.5">
                <div className="flex items-center gap-3 text-sm">
                  <CalendarDays size={14} className="text-gray-400" />
                  <span className={h.holiday_date < todayISO() ? 'text-gray-400' : 'text-gray-900'}>
                    {h.holiday_date}
                  </span>
                  <span className="text-gray-600">{h.name}</span>
                </div>
                <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-600"
                  onClick={() => deleteHoliday(h.holiday_date)}>
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* 반려 사유 입력 */}
      <Dialog open={!!rejectTarget} onOpenChange={(v) => { if (!v) setRejectTarget(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>연차 반려</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-gray-600">
              {rejectTarget?.employees?.name}님의{' '}
              {rejectTarget && formatRange(rejectTarget.start_date, rejectTarget.end_date)} 신청을 반려합니다.
            </p>
            <div className="space-y-1">
              <Label>반려 사유 (신청자에게 Slack DM으로 전달됩니다)</Label>
              <Input
                value={rejectMemo}
                placeholder="예) 해당 주에 행사가 있어 조정 부탁드립니다"
                onChange={(e) => setRejectMemo(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>취소</Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (rejectTarget) review(rejectTarget, 'reject', rejectMemo || null)
                setRejectTarget(null)
              }}
            >
              반려
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 승인된 연차 취소 */}
      <AlertDialog open={!!cancelTarget} onOpenChange={(v) => { if (!v) setCancelTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>승인된 연차 취소</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelTarget?.employees?.name}님의{' '}
              {cancelTarget && formatRange(cancelTarget.start_date, cancelTarget.end_date)}{' '}
              ({cancelTarget?.days}일) 연차를 취소합니다.<br />
              차감됐던 연차가 잔여로 돌아오고, 구글 캘린더 일정도 함께 삭제됩니다.<br />
              신청자에게 Slack DM으로 알림이 갑니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>닫기</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (cancelTarget) review(cancelTarget, 'cancel', '관리자 취소')
                setCancelTarget(null)
              }}
            >
              취소 처리
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 부여 일수 수동 조정 */}
      <Dialog open={!!grantTarget} onOpenChange={(v) => { if (!v) setGrantTarget(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{grantTarget?.employeeName} — 연차 부여 조정</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-xs text-gray-500">
              {grantTarget?.period && periodLabel(grantTarget.period)} 구간에만 적용됩니다.
            </p>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">발생</Label>
                <Input type="number" step="0.5" value={grantForm.granted}
                  onChange={(e) => setGrantForm({ ...grantForm, granted: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">이월</Label>
                <Input type="number" step="0.5" value={grantForm.carried}
                  onChange={(e) => setGrantForm({ ...grantForm, carried: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">가감</Label>
                <Input type="number" step="0.5" value={grantForm.adjustment}
                  onChange={(e) => setGrantForm({ ...grantForm, adjustment: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">메모</Label>
              <Input value={grantForm.memo} placeholder="예) 포상 휴가 1일 추가"
                onChange={(e) => setGrantForm({ ...grantForm, memo: e.target.value })} />
            </div>
            <p className="text-xs text-gray-400">
              사용 가능 총량 = 발생 + 이월 + 가감 ={' '}
              <b>{(Number(grantForm.granted) || 0) + (Number(grantForm.carried) || 0) + (Number(grantForm.adjustment) || 0)}일</b>
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGrantTarget(null)}>취소</Button>
            <Button onClick={saveGrant}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
