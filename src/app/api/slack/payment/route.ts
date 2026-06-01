/**
 * Slack /결제 슬래시 커맨드 직접 수신 웹훅
 *
 * Slack App 설정에서 이 URL을 Slash Command Request URL로 등록:
 *   https://your-domain/api/slack/payment
 *
 * 커맨드 형식:
 *   /결제 상호명 금액 담당자 [메모]
 *   예) /결제 ABC마케팅 1500000 김팀장 계약금 입금완료
 *       /결제 XYZ회사 500000 박팀장 잔금처리요망
 *
 * 상태 키워드 (메모에 포함 시 자동 인식):
 *   - "잔금처리요망" 또는 "잔금" → ⚠ 잔금 처리 요망
 *   - "미입금" → 🔴 미입금
 *   - 그 외 → 입금완료로 처리
 *
 * 환경변수:
 *   SLACK_SIGNING_SECRET: Slack App의 Signing Secret (보안 서명 검증용)
 */

import { createClient } from '@supabase/supabase-js'
import { createHmac } from 'crypto'
import type { Database } from '@/types/database'

const supabase = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type PaymentStatus = '입금완료' | '잔금처리요망' | '미입금'

/** Slack 서명 검증 (HMAC-SHA256) */
function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const baseString = `v0:${timestamp}:${rawBody}`
  const hmac = createHmac('sha256', signingSecret)
  const computed = `v0=${hmac.update(baseString).digest('hex')}`
  // timing-safe comparison (constant time)
  if (computed.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

/** 커맨드 텍스트 파싱: 상호명 금액 담당자 [메모...] */
function parseCommandText(text: string): {
  clientName: string
  amount: number
  manager: string
  memo: string
  status: PaymentStatus
} | null {
  const parts = text.trim().split(/\s+/)
  if (parts.length < 3) return null

  const clientName = parts[0]
  const rawAmount = parts[1].replace(/[,원]/g, '')
  const amount = parseFloat(rawAmount)
  if (isNaN(amount) || amount <= 0) return null

  const manager = parts[2]
  const memoRaw = parts.slice(3).join(' ')

  let status: PaymentStatus = '입금완료'
  let memo = memoRaw

  if (/잔금처리요망|잔금처리/.test(memoRaw)) {
    status = '잔금처리요망'
    memo = memoRaw.replace(/잔금처리요망|잔금처리/g, '').trim()
  } else if (/미입금/.test(memoRaw)) {
    status = '미입금'
    memo = memoRaw.replace(/미입금/g, '').trim()
  }

  return { clientName, amount, manager, memo, status }
}

/** 클라이언트 조회 또는 생성 */
async function findOrCreateClient(name: string, manager: string): Promise<string | null> {
  const { data: existing } = await supabase
    .from('clients')
    .select('id')
    .ilike('name', name)
    .limit(1)
    .single()

  if (existing) return existing.id

  const { data: created, error } = await supabase
    .from('clients')
    .insert({ name, manager: manager || null })
    .select('id')
    .single()

  if (error) return null
  return created?.id ?? null
}

/** 진행중 프로젝트 조회 또는 신규 생성 */
async function findOrCreateProject(clientId: string, clientName: string, amount: number, date: string): Promise<{ id: string; isNew: boolean } | null> {
  const { data: ongoing } = await supabase
    .from('projects')
    .select('id')
    .eq('client_id', clientId)
    .eq('status', 'ongoing')
    .order('created_at', { ascending: false })
    .limit(1)

  if (ongoing && ongoing.length > 0) {
    return { id: ongoing[0].id, isNew: false }
  }

  const { data: created, error } = await supabase
    .from('projects')
    .insert({
      client_id: clientId,
      name: clientName,
      total_amount: amount,
      contract_date: date,
      status: 'ongoing',
    })
    .select('id')
    .single()

  if (error) return null
  return created ? { id: created.id, isNew: true } : null
}

function formatKRW(n: number): string {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' }).format(n)
}

export async function POST(request: Request) {
  const rawBody = await request.text()

  // Slack 서명 검증
  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (signingSecret) {
    const timestamp = request.headers.get('x-slack-request-timestamp') ?? ''
    const signature = request.headers.get('x-slack-signature') ?? ''

    // 5분 이상 된 요청 거부 (replay attack 방지)
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
      return Response.json({ error: 'Request too old' }, { status: 400 })
    }

    if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
      return Response.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  const params = new URLSearchParams(rawBody)
  const text = params.get('text') ?? ''
  const userName = params.get('user_name') ?? ''

  if (!text.trim()) {
    return Response.json({
      response_type: 'ephemeral',
      text: [
        '❌ 형식이 올바르지 않습니다.',
        '사용법: `/결제 상호명 금액 담당자 [메모]`',
        '예시: `/결제 ABC마케팅 1500000 김팀장 계약금`',
        '상태 키워드: `잔금처리요망`, `미입금` (기본: 입금완료)',
      ].join('\n'),
    })
  }

  const parsed = parseCommandText(text)
  if (!parsed) {
    return Response.json({
      response_type: 'ephemeral',
      text: [
        '❌ 파싱 실패. 상호명, 금액, 담당자를 모두 입력해주세요.',
        '예시: `/결제 ABC마케팅 1500000 김팀장`',
      ].join('\n'),
    })
  }

  const { clientName, amount, manager, memo, status } = parsed
  const today = new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD

  // 클라이언트 조회/생성
  const clientId = await findOrCreateClient(clientName, manager)
  if (!clientId) {
    return Response.json({
      response_type: 'ephemeral',
      text: `❌ 클라이언트 처리 실패. 관리자에게 문의하세요.`,
    })
  }

  // 프로젝트 조회/생성
  const project = await findOrCreateProject(clientId, clientName, amount, today)

  // 메모 구성
  const statusTag =
    status === '잔금처리요망' ? '⚠ 잔금 처리 요망' :
    status === '미입금' ? '🔴 미입금' : ''
  const paymentType = status === '잔금처리요망' ? '잔금' : status === '미입금' ? '기타' : null
  const fullMemo = [statusTag, memo].filter(Boolean).join(' | ') || null

  const { error: insertErr } = await supabase.from('payments').insert({
    project_id: project?.id ?? null,
    amount,
    payment_date: today,
    payment_type: paymentType,
    manager: manager || null,
    memo: fullMemo,
    source: 'slack',
    external_id: `slack_direct_${today}_${clientName.replace(/\s+/g, '-')}_${amount}_${Date.now()}`,
    client_name_raw: clientName,
    matched: !!project,
  })

  if (insertErr) {
    return Response.json({
      response_type: 'ephemeral',
      text: `❌ 저장 실패: ${insertErr.message}`,
    })
  }

  const statusEmoji = status === '잔금처리요망' ? '⚠️' : status === '미입금' ? '🔴' : '✅'
  const projectNote = project?.isNew ? ' (신규 프로젝트 자동 생성)' : ''

  return Response.json({
    response_type: 'in_channel',
    text: [
      `${statusEmoji} *결제 등록 완료* — ${userName ? `@${userName}` : ''}`,
      `> 상호명: *${clientName}*`,
      `> 금액: *${formatKRW(amount)}*`,
      `> 담당자: ${manager}`,
      `> 날짜: ${today}`,
      `> 상태: ${statusTag || '입금완료'}${projectNote}`,
      memo ? `> 메모: ${memo}` : '',
    ].filter(Boolean).join('\n'),
  })
}
