/**
 * 세무사 PDF 명세서를 표로 읽어 돌려준다. 아무것도 저장하지 않는다.
 *
 *   POST /api/payroll/parse-pdf   multipart/form-data { file }
 */

import { createClient } from '@/lib/supabase/server'
import { readPdfGrid } from '@/lib/payroll/pdf'

export async function POST(request: Request) {
  // 이 라우트는 미들웨어의 /api 예외 대상이라 여기서 직접 검사한다
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 })

  const file = (await request.formData()).get('file')
  if (!(file instanceof File)) return Response.json({ error: 'file이 필요합니다.' }, { status: 400 })

  try {
    const grid = await readPdfGrid(new Uint8Array(await file.arrayBuffer()))
    if (grid.length === 0) {
      return Response.json({ error: '글자를 읽을 수 없는 PDF입니다. 스캔본이면 세무사에게 엑셀 파일을 요청해 주세요.' }, { status: 400 })
    }
    return Response.json({ grid })
  } catch (e) {
    if (e instanceof Error && e.name === 'PasswordException') {
      return Response.json({ error: '비밀번호가 걸린 PDF입니다. 비밀번호를 풀어 저장한 뒤 올려 주세요.' }, { status: 400 })
    }
    console.error('[payroll/parse-pdf] 실패:', e)
    return Response.json({ error: 'PDF를 읽지 못했습니다.' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
