import 'server-only'
import { z } from 'zod'
import { requireAdminApi, type Admin } from '@/lib/auth/admin'
import { RateError } from './engine'
import { HttpError } from './server'

/**
 * 인센티브 정산 API 공통 처리.
 * /api 는 로그인 미들웨어 밖이라 라우트마다 여기서 관리자를 확인한다 (아니면 404).
 */
export async function handle(fn: (admin: Admin) => Promise<unknown>): Promise<Response> {
  const admin = await requireAdminApi()
  if (admin instanceof Response) return admin
  try {
    return Response.json((await fn(admin)) ?? { ok: true })
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status })
    if (e instanceof RateError) return Response.json({ error: e.message }, { status: 400 })
    if (e instanceof z.ZodError) {
      return Response.json({ error: '입력값을 확인해 주세요. ' + e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' / ') }, { status: 400 })
    }
    console.error('[incentives]', e)
    return Response.json({ error: e instanceof Error ? e.message : '처리하지 못했습니다.' }, { status: 500 })
  }
}

export async function readJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new HttpError(400, 'JSON 본문이 필요합니다.')
  }
  return schema.parse(raw)
}

export function readYm(request: Request): { year: number; month: number } {
  const url = new URL(request.url)
  return ymSchema.parse({ year: Number(url.searchParams.get('year')), month: Number(url.searchParams.get('month')) })
}

/** 원 단위 정수 금액 */
export const won = z.number().int().min(-1e13).max(1e13)
export const ymSchema = z.object({ year: z.number().int().min(2020).max(2100), month: z.number().int().min(1).max(12) })
export const fill = z.enum(['red', 'yellow', 'green']).nullable()
export const id = z.string().uuid()
