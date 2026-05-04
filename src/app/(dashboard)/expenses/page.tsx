'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { toast } from 'sonner'
import { Copy, Plus, Pencil, Trash2, Check, RefreshCw } from 'lucide-react'
import { formatKRW } from '@/lib/calculations/settlement'
import type { ExpenseCategory, MonthlyExpense } from '@/types/database'

const TYPE_LABEL: Record<string, string> = { fixed: '고정비', variable: '변동비', special: '특수비용' }
const TYPE_COLOR: Record<string, string> = {
  fixed: 'border-blue-200 bg-blue-50/40',
  variable: 'border-green-200 bg-green-50/40',
  special: 'border-yellow-200 bg-yellow-50/40',
}
const TYPE_BADGE: Record<string, string> = {
  fixed: 'bg-blue-100 text-blue-700',
  variable: 'bg-green-100 text-green-700',
  special: 'bg-yellow-100 text-yellow-700',
}

type NewRow = { name: string; is_recurring: boolean }

export default function ExpensesPage() {
  const supabase = createClient()
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)

  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [amounts, setAmounts]       = useState<Record<string, string>>({})
  const [memos, setMemos]           = useState<Record<string, string>>({})
  const [existingIds, setExistingIds] = useState<Record<string, string>>({})
  const [saving, setSaving]         = useState(false)
  const [savingId, setSavingId]     = useState<string | null>(null)

  // 항목 추가 (섹션별 인라인 행)
  const [newRows, setNewRows] = useState<Record<string, NewRow>>({})

  // 항목 수정 다이얼로그
  const [editOpen, setEditOpen]   = useState(false)
  const [editTarget, setEditTarget] = useState<ExpenseCategory | null>(null)
  const [editForm, setEditForm]   = useState({ name: '', is_recurring: false })

  async function load() {
    const { data: cats } = await supabase
      .from('expense_categories')
      .select('*')
      .eq('active', true)
      .order('parent_type')
      .order('created_at')
    setCategories(cats ?? [])

    const { data: existing } = await supabase
      .from('monthly_expenses')
      .select('*')
      .eq('year', year)
      .eq('month', month)

    const amountMap: Record<string, string> = {}
    const memoMap:   Record<string, string> = {}
    const idMap:     Record<string, string> = {}
    for (const e of existing ?? []) {
      if (e.category_id) {
        amountMap[e.category_id] = String(e.amount)
        memoMap[e.category_id]   = e.memo ?? ''
        idMap[e.category_id]     = e.id
      }
    }
    setAmounts(amountMap)
    setMemos(memoMap)
    setExistingIds(idMap)
  }

  useEffect(() => { load() }, [year, month])

  // ── 지출 금액 개별 저장 ──────────────────────────────────
  async function saveSingle(catId: string) {
    const amount = parseFloat(amounts[catId] ?? '0')
    if (isNaN(amount) || amount < 0) { toast.error('금액을 확인해주세요.'); return }
    setSavingId(catId)
    const payload = { year, month, category_id: catId, amount, memo: memos[catId] || null }
    if (existingIds[catId]) {
      await supabase.from('monthly_expenses').update(payload).eq('id', existingIds[catId])
    } else {
      const { data } = await supabase.from('monthly_expenses').insert(payload).select('id').single()
      if (data) setExistingIds((prev) => ({ ...prev, [catId]: data.id }))
    }
    setSavingId(null)
    toast.success('저장되었습니다.')
  }

  // ── 전체 저장 ────────────────────────────────────────────
  async function saveAll() {
    setSaving(true)
    const updatedIds = { ...existingIds }
    for (const cat of categories) {
      const amount = parseFloat(amounts[cat.id] ?? '0')
      if (isNaN(amount) || amount <= 0) continue
      const payload = { year, month, category_id: cat.id, amount, memo: memos[cat.id] || null }
      if (updatedIds[cat.id]) {
        await supabase.from('monthly_expenses').update(payload).eq('id', updatedIds[cat.id])
      } else {
        const { data } = await supabase.from('monthly_expenses').insert(payload).select('id').single()
        if (data) updatedIds[cat.id] = data.id
      }
    }
    setExistingIds(updatedIds)
    setSaving(false)
    toast.success('전체 저장되었습니다.')
  }

  // ── 지난달 고정비 복사 ────────────────────────────────────
  async function copyLastMonth() {
    const ly = month === 1 ? year - 1 : year
    const lm = month === 1 ? 12 : month - 1
    const { data } = await supabase
      .from('monthly_expenses')
      .select('*, expense_categories(is_recurring)')
      .eq('year', ly).eq('month', lm)
    const updated = { ...amounts }
    for (const e of data ?? []) {
      const cat = e.expense_categories as unknown as { is_recurring: boolean } | null
      if (cat?.is_recurring && e.category_id) updated[e.category_id] = String(e.amount)
    }
    setAmounts(updated)
    toast.success('지난달 고정비가 복사되었습니다.')
  }

  // ── 항목 추가 ────────────────────────────────────────────
  function initNewRow(type: string) {
    setNewRows((prev) => ({ ...prev, [type]: { name: '', is_recurring: false } }))
  }

  async function confirmAddRow(type: string) {
    const row = newRows[type]
    if (!row?.name.trim()) { toast.error('항목명을 입력해주세요.'); return }
    const { error } = await supabase.from('expense_categories').insert({
      name: row.name.trim(),
      parent_type: type as ExpenseCategory['parent_type'],
      is_recurring: row.is_recurring,
      is_custom: true,
      active: true,
    })
    if (error) { toast.error('추가 실패: ' + error.message); return }
    setNewRows((prev) => { const n = { ...prev }; delete n[type]; return n })
    toast.success(`'${row.name}' 항목이 추가되었습니다.`)
    load()
  }

  // ── 항목 수정 ────────────────────────────────────────────
  function openEdit(cat: ExpenseCategory) {
    setEditTarget(cat)
    setEditForm({ name: cat.name, is_recurring: cat.is_recurring })
    setEditOpen(true)
  }

  async function handleEditSave() {
    if (!editTarget) return
    if (!editForm.name.trim()) { toast.error('항목명을 입력해주세요.'); return }
    const { error } = await supabase
      .from('expense_categories')
      .update({ name: editForm.name.trim(), is_recurring: editForm.is_recurring })
      .eq('id', editTarget.id)
    if (error) { toast.error('수정 실패'); return }
    setEditOpen(false)
    toast.success('항목이 수정되었습니다.')
    load()
  }

  // ── 이번 달 지출 데이터만 삭제 ────────────────────────────
  async function handleDeleteMonthly(cat: ExpenseCategory) {
    const monthlyId = existingIds[cat.id]
    const hasLocalData = cat.id in amounts || cat.id in memos
    if (!monthlyId && !hasLocalData) { toast.error('이 월에 저장된 데이터가 없습니다.'); return }
    if (!confirm(`'${cat.name}' ${year}년 ${month}월 데이터를 삭제하시겠습니까?`)) return
    if (monthlyId) {
      await supabase.from('monthly_expenses').delete().eq('id', monthlyId)
      setExistingIds((prev) => { const n = { ...prev }; delete n[cat.id]; return n })
    }
    setAmounts((prev) => { const n = { ...prev }; delete n[cat.id]; return n })
    setMemos((prev) => { const n = { ...prev }; delete n[cat.id]; return n })
    toast.success(`${year}년 ${month}월 데이터가 삭제되었습니다.`)
  }

  // ── 카테고리 자체 삭제 (커스텀 항목만, 전체 월 영향) ─────
  async function handleDeleteCategory() {
    if (!editTarget) return
    if (!editTarget.is_custom) { toast.error('기본 항목은 삭제할 수 없습니다.'); return }
    if (!confirm(`'${editTarget.name}' 항목을 완전히 삭제하시겠습니까?\n모든 월의 해당 항목이 숨김 처리됩니다.`)) return
    await supabase.from('expense_categories').update({ active: false }).eq('id', editTarget.id)
    toast.success('항목이 삭제되었습니다.')
    setEditOpen(false)
    load()
  }

  const grouped = categories.reduce<Record<string, ExpenseCategory[]>>((acc, cat) => {
    if (!acc[cat.parent_type]) acc[cat.parent_type] = []
    acc[cat.parent_type].push(cat)
    return acc
  }, {})

  const total = categories.reduce((sum, cat) => sum + (parseFloat(amounts[cat.id] ?? '0') || 0), 0)

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">월별 지출 입력</h1>
        <div className="flex items-center gap-2">
          <select className="border rounded-md px-3 py-2 text-sm" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[2023, 2024, 2025, 2026].map((y) => <option key={y} value={y}>{y}년</option>)}
          </select>
          <select className="border rounded-md px-3 py-2 text-sm" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}월</option>)}
          </select>
          <Button variant="outline" size="sm" onClick={copyLastMonth}>
            <Copy size={14} className="mr-1" />지난달 고정비 복사
          </Button>
        </div>
      </div>

      {/* 섹션별 지출 입력 */}
      {(['fixed', 'variable', 'special'] as const).map((type) => {
        const cats = grouped[type] ?? []
        const newRow = newRows[type]
        const sectionTotal = cats.reduce((s, c) => s + (parseFloat(amounts[c.id] ?? '0') || 0), 0)

        return (
          <Card key={type} className={`border ${TYPE_COLOR[type]}`}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base">{TYPE_LABEL[type]}</CardTitle>
                  <span className="text-xs text-gray-500">{formatKRW(sectionTotal)}</span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-gray-500 hover:text-gray-900 h-7 text-xs"
                  onClick={() => initNewRow(type)}
                >
                  <Plus size={13} className="mr-1" />항목 추가
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {cats.length === 0 && !newRow && (
                <p className="text-xs text-gray-400 py-2">항목이 없습니다. "+ 항목 추가"를 눌러 추가하세요.</p>
              )}

              {cats.map((cat) => {
                const isSaved = !!existingIds[cat.id] && (parseFloat(amounts[cat.id] ?? '0') || 0) > 0
                return (
                  <div key={cat.id} className="flex flex-col sm:flex-row sm:items-center gap-2">
                    {/* 항목명 + 모바일 수정/삭제 */}
                    <div className="flex items-center justify-between sm:justify-start gap-1">
                      <div className="flex-1 sm:w-36 sm:flex-none flex items-center gap-1 text-sm font-medium text-gray-800">
                        <span className="truncate">{cat.name}</span>
                        {cat.is_recurring && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 shrink-0">반복</span>
                        )}
                      </div>
                      <div className="flex sm:hidden gap-1">
                        <button onClick={() => openEdit(cat)} className="text-gray-300 hover:text-gray-600 transition-colors" title="항목 수정">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => handleDeleteMonthly(cat)} className="text-gray-300 hover:text-red-500 transition-colors" title="이번 달 데이터 삭제">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {/* 금액 + 메모 + 저장 */}
                    <div className="flex items-center gap-2 flex-1">
                      {/* 금액 */}
                      <Input
                        type="number"
                        className="w-28 sm:w-36 h-8 text-sm text-right bg-white shrink-0"
                        placeholder="0"
                        value={amounts[cat.id] ?? ''}
                        onChange={(e) => setAmounts((prev) => ({ ...prev, [cat.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveSingle(cat.id) }}
                      />

                      {/* 메모 */}
                      <Input
                        className="flex-1 min-w-0 h-8 text-sm bg-white"
                        placeholder="메모 (선택)"
                        value={memos[cat.id] ?? ''}
                        onChange={(e) => setMemos((prev) => ({ ...prev, [cat.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveSingle(cat.id) }}
                      />

                      {/* 저장 버튼 */}
                      <Button
                        size="sm"
                        variant={isSaved ? 'outline' : 'default'}
                        className="h-8 w-14 text-xs shrink-0"
                        onClick={() => saveSingle(cat.id)}
                        disabled={savingId === cat.id}
                      >
                        {savingId === cat.id
                          ? <RefreshCw size={12} className="animate-spin" />
                          : isSaved ? <><Check size={11} className="mr-0.5" />저장</>
                          : '저장'}
                      </Button>
                    </div>

                    {/* 수정/삭제 - 데스크톱만 */}
                    <div className="hidden sm:flex gap-1">
                      <button onClick={() => openEdit(cat)} className="text-gray-300 hover:text-gray-600 transition-colors" title="항목 수정">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => handleDeleteMonthly(cat)} className="text-gray-300 hover:text-red-500 transition-colors" title="이번 달 데이터 삭제">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}

              {/* 신규 항목 입력 행 */}
              {newRow && (
                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-dashed border-gray-200">
                  <Input
                    className="flex-1 min-w-[140px] h-8 text-sm bg-white"
                    placeholder="항목명"
                    value={newRow.name}
                    onChange={(e) => setNewRows((prev) => ({ ...prev, [type]: { ...prev[type], name: e.target.value } }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') confirmAddRow(type) }}
                    autoFocus
                  />
                  <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer shrink-0">
                    <input
                      type="checkbox"
                      checked={newRow.is_recurring}
                      onChange={(e) => setNewRows((prev) => ({ ...prev, [type]: { ...prev[type], is_recurring: e.target.checked } }))}
                    />
                    매월 반복
                  </label>
                  <Button size="sm" className="h-8 text-xs" onClick={() => confirmAddRow(type)}>
                    <Plus size={12} className="mr-0.5" />추가
                  </Button>
                  <button
                    onClick={() => setNewRows((prev) => { const n = { ...prev }; delete n[type]; return n })}
                    className="text-gray-400 hover:text-gray-700 text-xs"
                  >
                    취소
                  </button>
                </div>
              )}
            </CardContent>
          </Card>
        )
      })}

      {/* 하단 합계 + 전체 저장 */}
      <div className="flex items-center justify-between bg-white rounded-lg border p-4">
        <div className="text-sm text-gray-500">
          {year}년 {month}월 총 지출:{' '}
          <span className="font-bold text-gray-900 text-base">{formatKRW(total)}</span>
        </div>
        <Button onClick={saveAll} disabled={saving}>
          {saving ? '저장 중...' : '전체 저장'}
        </Button>
      </div>

      {/* 항목 수정 다이얼로그 */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>지출 항목 수정</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>항목명 *</Label>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') handleEditSave() }}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label>분류</Label>
              <div className="text-sm text-gray-500">
                {editTarget && (
                  <span className={`text-xs px-2 py-1 rounded-full ${TYPE_BADGE[editTarget.parent_type]}`}>
                    {TYPE_LABEL[editTarget.parent_type]}
                  </span>
                )}
                <span className="text-xs text-gray-400 ml-2">(분류 변경은 삭제 후 재추가)</span>
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={editForm.is_recurring}
                onChange={(e) => setEditForm({ ...editForm, is_recurring: e.target.checked })}
              />
              <span className="text-sm">매월 반복 고정비 (지난달 복사 시 포함)</span>
            </label>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            {editTarget?.is_custom && (
              <Button variant="destructive" className="sm:mr-auto" onClick={handleDeleteCategory}>
                항목 전체 삭제
              </Button>
            )}
            <Button variant="outline" onClick={() => setEditOpen(false)}>취소</Button>
            <Button onClick={handleEditSave}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
