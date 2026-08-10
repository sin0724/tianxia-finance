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
import { LEAVE_TYPE_LABEL, periodLabel, todayISO } from '@/lib/leave/policy'
import { formatRange } from '@/lib/leave/calc'
import type { LeaveRequest, CompanyHoliday } from '@/types/database'
import { Check, X, Trash2, Plus, CalendarDays, Link2, Pencil, Undo2 } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

type RequestRow = LeaveRequest & { employees: { name: string } | null }

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

  const load = useCallback(async () => {
    const [{ data: reqs }, bals, { data: hols }] = await Promise.all([
      supabase
        .from('leave_requests')
        .select('*, employees(name)')
        .order('start_date', { ascending: false }),
      getAllLeaveBalances(supabase),
      supabase.from('company_holidays').select('*').order('holiday_date'),
    ])
    setRequests((reqs as unknown as RequestRow[]) ?? [])
    setBalances(bals)
    setHolidays(hols ?? [])
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
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={8} className="text-center py-8 text-gray-400">불러오는 중...</TableCell></TableRow>
                ) : balances.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center py-8 text-gray-400">재직 중인 직원이 없습니다.</TableCell></TableRow>
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
                        <div className="text-xs text-blue-600">다음 발생 {b.nextAccrualAt} (+1일)</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {b.granted}
                      {b.isManualGrant && <span className="ml-1 text-[10px] text-gray-400">수동</span>}
                    </TableCell>
                    <TableCell className="text-right text-gray-500">{b.carriedOver || '-'}</TableCell>
                    <TableCell className="text-right">{b.used}</TableCell>
                    <TableCell className="text-right text-amber-600">{b.pending || '-'}</TableCell>
                    <TableCell className={`text-right font-semibold ${b.remaining < 0 ? 'text-red-600' : ''}`}>
                      {b.remaining}
                    </TableCell>
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

          <p className="text-xs text-gray-400 mt-2 leading-relaxed">
            <Link2 size={11} className="inline mr-1" />
            발생 일수는 입사 첫 해에는 만 1개월마다 1일(최대 11일), 만 1년차부터 매 연차연도 15일로 자동 계산됩니다.
            연필 버튼으로 직접 지정하면 그 값이 우선합니다.
            <br />
            우리 회사는 5인 미만 사업장이라 미사용 연차에 대한 수당은 발생하지 않으며, 급여와 연동되지 않습니다.
          </p>
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
