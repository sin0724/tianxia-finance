/**
 * 인센티브 정산 — CRM 담당자명 연결. 관리자만 (아니면 404).
 * 설정에 없는 CRM 담당자 값(새 사람 · 새 팀 표기)을 기존 담당자에 붙이거나 새 담당자로 만든다.
 * 그다음 이 달 정산표가 없는 담당자 것을 만들고 CRM 동기화를 한다.
 *
 *   POST /api/incentives/owners  { year, month, owner, managerId }   기존 담당자에 연결
 *   POST /api/incentives/owners  { year, month, owner, newName }     새 담당자로 추가
 */
import { z } from 'zod'
import { handle, id, readJson, ymSchema } from '@/lib/incentives/api'
import { assignOwner } from '@/lib/incentives/server'

const owner = z.string().trim().min(1).max(50)
const schema = z.union([
  ymSchema.extend({ owner, managerId: id }),
  ymSchema.extend({ owner, newName: z.string().trim().min(1).max(50) }),
])

export async function POST(request: Request) {
  return handle(async ({ supabase }) => assignOwner(supabase, await readJson(request, schema)))
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
