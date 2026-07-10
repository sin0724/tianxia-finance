'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/lib/toast'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { Client } from '@/types/database'

export default function ClientsPage() {
  const supabase = createClient()
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Client | null>(null)
  const [form, setForm] = useState({ name: '', manager: '', contact: '', memo: '' })
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null)

  async function load() {
    const { data } = await supabase.from('clients').select('*').order('created_at', { ascending: false })
    setClients(data ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function openAdd() {
    setEditing(null)
    setForm({ name: '', manager: '', contact: '', memo: '' })
    setDialogOpen(true)
  }

  function openEdit(c: Client) {
    setEditing(c)
    setForm({ name: c.name, manager: c.manager ?? '', contact: c.contact ?? '', memo: c.memo ?? '' })
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!form.name) { toast.error('상호명은 필수입니다.'); return }
    const payload = { name: form.name, manager: form.manager || null, contact: form.contact || null, memo: form.memo || null }

    if (editing) {
      const { error } = await supabase.from('clients').update(payload).eq('id', editing.id)
      if (error) { toast.error(error.message); return }
      toast.success('클라이언트가 수정되었습니다.')
    } else {
      const { error } = await supabase.from('clients').insert(payload)
      if (error) { toast.error(error.message); return }
      toast.success('클라이언트가 추가되었습니다.')
    }
    setDialogOpen(false)
    load()
  }

  async function handleDelete(c: Client) {
    // 연결된 프로젝트 ID 조회
    const { data: linkedProjects } = await supabase
      .from('projects')
      .select('id')
      .eq('client_id', c.id)

    const projectIds = (linkedProjects ?? []).map((p) => p.id)

    if (projectIds.length > 0) {
      // 1. project_items 삭제
      const { error: itemsError } = await supabase
        .from('project_items')
        .delete()
        .in('project_id', projectIds)
      if (itemsError) { toast.error('상품 삭제 실패: ' + itemsError.message); return }

      // 2. payments 삭제
      const { error: paymentsError } = await supabase
        .from('payments')
        .delete()
        .in('project_id', projectIds)
      if (paymentsError) { toast.error('결제 내역 삭제 실패: ' + paymentsError.message); return }

      // 3. 프로젝트 삭제
      const { error: projectsError } = await supabase
        .from('projects')
        .delete()
        .in('id', projectIds)
      if (projectsError) { toast.error('프로젝트 삭제 실패: ' + projectsError.message); return }
    }

    // 4. 클라이언트 삭제
    const { error } = await supabase.from('clients').delete().eq('id', c.id)
    if (error) { toast.error(error.message); return }

    toast.success(`"${c.name}" 및 연결된 프로젝트 ${projectIds.length}건이 삭제되었습니다.`)
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">클라이언트 관리</h1>
        <Button onClick={openAdd}><Plus size={16} className="mr-1" />클라이언트 추가</Button>
      </div>

      {/* 모바일 카드 뷰 */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="bg-white rounded-lg border text-center py-8 text-gray-400 text-sm">불러오는 중...</div>
        ) : clients.length === 0 ? (
          <div className="bg-white rounded-lg border text-center py-8 text-gray-400 text-sm">등록된 클라이언트가 없습니다.</div>
        ) : clients.map((c) => (
          <div key={c.id} className="bg-white rounded-lg border p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-gray-900">{c.name}</div>
                {c.manager && <div className="text-sm text-gray-500 mt-0.5">{c.manager}</div>}
                {c.contact && <div className="text-sm text-gray-400">{c.contact}</div>}
                {c.memo && <div className="text-xs text-gray-400 mt-1 truncate">{c.memo}</div>}
              </div>
              <div className="flex gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => openEdit(c)}><Pencil size={14} /></Button>
                <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-600" onClick={() => setDeleteTarget(c)}>
                  <Trash2 size={14} />
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
              <TableHead>상호명</TableHead>
              <TableHead>담당자</TableHead>
              <TableHead>연락처</TableHead>
              <TableHead>메모</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-gray-400">불러오는 중...</TableCell></TableRow>
            ) : clients.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-gray-400">등록된 클라이언트가 없습니다.</TableCell></TableRow>
            ) : clients.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell>{c.manager ?? '-'}</TableCell>
                <TableCell>{c.contact ?? '-'}</TableCell>
                <TableCell className="max-w-xs truncate">{c.memo ?? '-'}</TableCell>
                <TableCell>
                  <div className="flex gap-1 justify-end">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(c)}><Pencil size={14} /></Button>
                    <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-600" onClick={() => setDeleteTarget(c)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>클라이언트 삭제</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{deleteTarget?.name}&rdquo; 클라이언트를 삭제하시겠습니까?<br />
              연결된 프로젝트, 구성 상품, 결제 내역이 모두 삭제됩니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => { if (deleteTarget) { handleDelete(deleteTarget); setDeleteTarget(null) } }}
            >
              삭제
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? '클라이언트 수정' : '클라이언트 추가'}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>상호명 *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>담당자</Label>
              <Input value={form.manager} onChange={(e) => setForm({ ...form, manager: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>연락처</Label>
              <Input value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>메모</Label>
              <Input value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
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
