'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatKRW } from '@/lib/calculations/settlement'
import { parseLedgerPaste, type ParsedRow } from '@/lib/payroll/parse'
import { toast } from '@/lib/toast'
import { AlertTriangle, ClipboardPaste, Upload } from 'lucide-react'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  employees: { id: string; name: string }[]
  onApply: (rows: ParsedRow[]) => void
}

/**
 * 세무사가 회신한 급여장부(엑셀 파일 또는 붙여넣기)로 인센티브 최종 금액과 세액을 일괄 반영한다.
 * 반영 전에 반드시 미리보기로 확인시킨다.
 */
export function LedgerPasteDialog({ open, onOpenChange, employees, onApply }: Props) {
  const [text, setText] = useState('')

  const parsed = useMemo(
    () => (text.trim() ? parseLedgerPaste(text, employees) : null),
    [text, employees]
  )

  // 엑셀 파일은 복사·붙여넣기와 같은 탭 구분 표로 바꿔 같은 파서와 미리보기를 탄다
  async function handleFile(file: File | undefined) {
    if (!file) return
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' })
      setText(XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]], { FS: '\t' }))
    } catch {
      toast.error('엑셀 파일을 읽지 못했습니다. 비밀번호가 걸려 있으면 풀고 올려 주세요.')
    }
  }

  function handleApply() {
    if (!parsed || parsed.rows.length === 0) return
    onApply(parsed.rows)
    setText('')
    onOpenChange(false)
  }

  function handleClose(next: boolean) {
    if (!next) setText('')
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardPaste size={18} />
            세무사 급여장부 올리기
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-gray-500 leading-relaxed">
            세무사가 보내온 사업소득지급대장 엑셀 파일을 올리거나, <strong>머리글 행부터 마지막 직원 행까지</strong> 복사해 아래에 붙여넣으세요.
            이름으로 직원을 찾아 인센티브 최종 금액과 세액을 반영합니다.
          </p>

          <label className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-3 text-sm text-gray-600 cursor-pointer hover:bg-gray-50">
            <Upload size={16} className="text-gray-400" />
            엑셀 파일 선택 (.xls, .xlsx)
            <input type="file" accept=".xls,.xlsx" className="hidden"
              onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = '' }} />
          </label>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'여기에 붙여넣기 (Ctrl+V)\n\n예)\nNO\t성 명\t귀속년월\t지급액\t기본급\t소득세\t지방소득세\t차인지급액\n1\t홍길동\t2026.08\t600000\t\t18000\t1800\t580200'}
            className="w-full h-36 rounded-lg border border-input bg-transparent px-3 py-2 text-xs font-mono outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />

          {parsed && parsed.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
              {parsed.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-1.5 text-xs text-amber-800">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {parsed && parsed.rows.length > 0 && (
            <div className="border rounded-lg overflow-x-auto max-h-72 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>직원</TableHead>
                    <TableHead className="text-right">기본급</TableHead>
                    <TableHead className="text-right">인센티브</TableHead>
                    <TableHead className="text-right">소득세</TableHead>
                    <TableHead className="text-right">지방소득세</TableHead>
                    <TableHead className="text-right">차인지급액</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsed.rows.map((r) => {
                    const tax = r.baseIncomeTax + r.baseLocalTax + r.incentiveIncomeTax + r.incentiveLocalTax
                    const net = r.base + r.incentive - tax
                    return (
                      <TableRow key={r.employeeId ?? r.rawName}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-1.5">
                            {r.matchedName ?? r.rawName}
                            {r.fuzzy && <Badge variant="outline" className="text-xs py-0 text-amber-600 border-amber-300">추정</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-sm">{formatKRW(r.base)}</TableCell>
                        <TableCell className="text-right text-sm text-blue-600">
                          {r.incentive > 0 ? formatKRW(r.incentive) : '-'}
                        </TableCell>
                        <TableCell className="text-right text-sm text-red-500">
                          {formatKRW(r.baseIncomeTax + r.incentiveIncomeTax)}
                        </TableCell>
                        <TableCell className="text-right text-sm text-red-500">
                          {formatKRW(r.baseLocalTax + r.incentiveLocalTax)}
                        </TableCell>
                        <TableCell className="text-right text-sm font-semibold text-green-700">
                          {formatKRW(net)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>취소</Button>
          <Button onClick={handleApply} disabled={!parsed || parsed.rows.length === 0}>
            {parsed?.rows.length ? `${parsed.rows.length}명 반영` : '반영'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
