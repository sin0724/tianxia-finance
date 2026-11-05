'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatKRW } from '@/lib/calculations/settlement'
import {
  deductionsOf, grossOf, matchEmployee, parseStatement, STATEMENT_KIND_LABEL,
  type ParsedStatement, type StatementKind, type StatementSheet,
} from '@/lib/payroll/statement'
import { saveStatement } from '@/lib/payroll/save-statement'
import { toast } from '@/lib/toast'
import { AlertTriangle, Check, FileUp } from 'lucide-react'

const NEW_EMPLOYEE = 'new'

interface SavedStatement { employeeId: string; name: string; kind: StatementKind | 'cash' | null }

interface Props {
  year: number
  month: number
  /** 퇴사자까지 전체 직원 */
  employees: { id: string; name: string }[]
  saved: SavedStatement[]
  onDone: () => void
}

interface Preview {
  filename: string
  parsed: ParsedStatement
  /** 명세서 이름 → 직원 id | NEW_EMPLOYEE | '' */
  picks: Record<string, string>
  fuzzy: Set<string>
}

async function readPdf(file: File): Promise<StatementSheet[]> {
  const body = new FormData()
  body.append('file', file)
  const res = await fetch('/api/payroll/parse-pdf', { method: 'POST', body })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? 'PDF를 읽지 못했습니다.')
  return [{ name: file.name, grid: json.grid }]
}

async function readExcel(file: File): Promise<StatementSheet[]> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' })
  return wb.SheetNames.map((name) => ({
    name,
    grid: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: '' })
      .map((row) => row.map((c) => String(c ?? '').trim())),
  }))
}

/** 세무사 명세서를 올리고, 미리보기에서 확인한 뒤 그 달의 최종 금액으로 확정한다 */
export function StatementUpload({ year, month, employees, saved, onDone }: Props) {
  const supabase = createClient()
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)

  async function handleFile(file: File | undefined) {
    if (!file) return
    setReading(true)
    try {
      const sheets = /\.pdf$/i.test(file.name) ? await readPdf(file) : await readExcel(file)
      const parsed = parseStatement(sheets, year, month)
      if (!parsed) {
        toast.error('명세서 표를 찾지 못했습니다. 세무사가 보낸 급여대장 파일인지 확인해 주세요.')
        return
      }
      const picks: Record<string, string> = {}
      const fuzzy = new Set<string>()
      for (const r of parsed.rows) {
        const m = matchEmployee(r.rawName, employees)
        picks[r.rawName] = m.employeeId ?? ''
        if (m.fuzzy) fuzzy.add(r.rawName)
      }
      setPreview({ filename: file.name, parsed, picks, fuzzy })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '파일을 읽지 못했습니다.')
    } finally {
      setReading(false)
    }
  }

  const check = useMemo(() => {
    if (!preview) return null
    const { parsed, picks } = preview
    const ids = Object.values(picks).filter((v) => v && v !== NEW_EMPLOYEE)
    const unresolved = parsed.rows.filter((r) => !picks[r.rawName]).length
    const duplicated = ids.length !== new Set(ids).size
    const picked = new Set(ids)
    return {
      unresolved, duplicated, picked,
      dropped: saved.filter((s) => s.kind === parsed.kind && !picked.has(s.employeeId)),
      otherKind: saved.filter((s) => s.kind && s.kind !== parsed.kind && picked.has(s.employeeId)),
      canConfirm: parsed.rows.length > 0 && parsed.errors.length === 0 && unresolved === 0 && !duplicated,
    }
  }, [preview, saved])

  async function confirm() {
    if (!preview || !check?.canConfirm) return
    const { parsed, picks, filename } = preview
    setSaving(true)
    try {
      const fresh = parsed.rows.filter((r) => picks[r.rawName] === NEW_EMPLOYEE)
      const created = new Map<string, string>()
      if (fresh.length > 0) {
        const { data, error } = await supabase.from('employees')
          .insert(fresh.map((r) => ({ name: r.rawName.trim(), insured: parsed.kind === 'insured' })))
          .select('id, name')
        if (error) throw new Error(error.message)
        for (const e of data ?? []) created.set(e.name, e.id)
      }
      await saveStatement(supabase, {
        year, month, kind: parsed.kind, filename,
        rows: parsed.rows.map((r) => ({
          ...r,
          employeeId: picks[r.rawName] === NEW_EMPLOYEE ? (created.get(r.rawName.trim()) as string) : picks[r.rawName],
        })),
        droppedIds: check.dropped.map((d) => d.employeeId),
      })
      toast.success(`${month}월 귀속 ${STATEMENT_KIND_LABEL[parsed.kind]} ${parsed.rows.length}명을 확정했습니다.`)
      if (fresh.length > 0) toast.info('새로 등록한 직원의 급여 조건은 직원 관리에서 채워 주세요.')
      setPreview(null)
      onDone()
    } catch (e) {
      toast.error('저장 실패: ' + (e instanceof Error ? e.message : ''))
    } finally {
      setSaving(false)
    }
  }

  const parsed = preview?.parsed
  const total = parsed?.rows.reduce(
    (t, r) => ({ gross: t.gross + grossOf(r), deduction: t.deduction + deductionsOf(r), net: t.net + r.net }),
    { gross: 0, deduction: 0, net: 0 },
  )
  const showEmployer = parsed?.rows.some((r) => r.employerInsurance > 0)

  return (
    <>
      <label className="flex items-center justify-center gap-2 rounded-lg border border-dashed bg-white p-4 text-sm text-gray-600 cursor-pointer hover:bg-gray-50">
        <FileUp size={16} className="text-gray-400" />
        {reading ? '명세서를 읽는 중...' : `${month}월 귀속 명세서 올리기 (엑셀, PDF)`}
        <input type="file" accept=".xls,.xlsx,.pdf" className="hidden" disabled={reading}
          onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = '' }} />
      </label>

      <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null) }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {month}월 귀속 {parsed ? STATEMENT_KIND_LABEL[parsed.kind] : ''} 명세서 확인
            </DialogTitle>
          </DialogHeader>

          {preview && parsed && check && total && (
            <div className="space-y-3 min-w-0">
              <p className="text-xs text-gray-500 break-all">
                {preview.filename}{parsed.sheetName !== preview.filename ? ` · 시트 "${parsed.sheetName}"` : ''}
              </p>

              {parsed.errors.length > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-1">
                  {parsed.errors.map((e) => (
                    <div key={e} className="flex items-start gap-1.5 text-xs text-red-800">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" /><span>{e}</span>
                    </div>
                  ))}
                  <p className="text-xs text-red-700 pt-1">이대로는 확정할 수 없습니다. 파일을 확인해 주세요.</p>
                </div>
              )}

              {(parsed.warnings.length > 0 || check.otherKind.length > 0 || check.dropped.length > 0) && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1 text-xs text-amber-800">
                  {parsed.warnings.map((w) => <p key={w}>{w}</p>)}
                  {check.otherKind.length > 0 && (
                    <p>{check.otherKind.map((s) => s.name).join(', ')}: 다른 명세서로 이미 반영된 금액을 이 파일 금액으로 바꿉니다.</p>
                  )}
                  {check.dropped.length > 0 && (
                    <p>{check.dropped.map((s) => s.name).join(', ')}: 이전 명세서에 있었지만 이번 파일에 없어 금액을 지웁니다.</p>
                  )}
                </div>
              )}

              {parsed.fileTotal && parsed.errors.length === 0 && (
                <p className="flex items-center gap-1 text-xs text-green-700">
                  <Check size={13} />파일 총계와 일치합니다.
                </p>
              )}

              {parsed.rows.length > 0 && (
                <div className="border rounded-lg overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>명세서 이름</TableHead>
                        <TableHead>직원</TableHead>
                        <TableHead className="text-right">기본급</TableHead>
                        <TableHead className="text-right">인센티브</TableHead>
                        <TableHead className="text-right">공제</TableHead>
                        <TableHead className="text-right">차인지급액</TableHead>
                        {showEmployer && <TableHead className="text-right">회사부담</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parsed.rows.map((r) => (
                        <TableRow key={r.rawName}>
                          <TableCell className="font-medium whitespace-nowrap">
                            {r.rawName}
                            {preview.fuzzy.has(r.rawName) && (
                              <Badge variant="outline" className="ml-1.5 text-xs py-0 text-amber-600 border-amber-300">추정</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <select
                              className={`border rounded-md px-2 py-1 text-sm max-w-36 ${preview.picks[r.rawName] ? '' : 'border-red-300 text-red-600'}`}
                              value={preview.picks[r.rawName]}
                              onChange={(e) => setPreview({ ...preview, picks: { ...preview.picks, [r.rawName]: e.target.value } })}
                            >
                              <option value="">선택해 주세요</option>
                              <option value={NEW_EMPLOYEE}>새 직원으로 등록</option>
                              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                            </select>
                          </TableCell>
                          <TableCell className="text-right text-sm">{formatKRW(r.base)}</TableCell>
                          <TableCell className="text-right text-sm text-blue-600">{r.incentive > 0 ? formatKRW(r.incentive) : '-'}</TableCell>
                          <TableCell className="text-right text-sm text-red-500">{formatKRW(deductionsOf(r))}</TableCell>
                          <TableCell className="text-right text-sm font-semibold text-green-700">{formatKRW(r.net)}</TableCell>
                          {showEmployer && <TableCell className="text-right text-sm text-purple-700">{formatKRW(r.employerInsurance)}</TableCell>}
                        </TableRow>
                      ))}
                      <TableRow className="bg-gray-50 font-semibold">
                        <TableCell colSpan={2}>합계 · 지급액 {formatKRW(total.gross)}</TableCell>
                        <TableCell /><TableCell />
                        <TableCell className="text-right text-sm text-red-500">{formatKRW(total.deduction)}</TableCell>
                        <TableCell className="text-right text-sm text-green-700">{formatKRW(total.net)}</TableCell>
                        {showEmployer && <TableCell />}
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              )}

              {check.unresolved > 0 && <p className="text-xs text-red-600">직원 관리에 없는 이름 {check.unresolved}명을 연결하거나 새로 등록해 주세요.</p>}
              {check.duplicated && <p className="text-xs text-red-600">한 직원에 두 이름이 연결되어 있습니다.</p>}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>취소</Button>
            <Button onClick={confirm} disabled={saving || !check?.canConfirm}>
              {saving ? '저장 중...' : `${parsed?.rows.length ?? 0}명 확정`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
