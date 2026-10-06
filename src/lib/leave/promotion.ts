/**
 * 연차 사용 촉진 (근로기준법 제61조)
 *
 *   1차  소멸 6개월 전 — 미사용 일수를 개인 DM 으로 통보하고, 10일 안에 사용 계획을 제출받는다
 *   2차  소멸 2개월 전 — 남은 일수와 소멸일을 다시 통보한다. 계획을 안 낸 사람은 관리자 채널에도 올려
 *        회사가 사용 시기를 지정해 통보하도록 한다
 *
 * 매일 한 번 runLeavePromotions() 를 돌리면(/api/leave/promotion) 그날 대상자에게만 보낸다.
 * leave_promotions 의 (직원, 연차연도, 차수) 유니크 제약으로 몇 번을 돌려도 한 번만 나간다.
 * 서버가 며칠 꺼져 있었어도 각 차수의 기간 안이면 늦게라도 보낸다.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { postSlackMessage, type SlackBlock } from '@/lib/slack'
import { getLeaveBalance } from './balance'
import { addDaysISO, currentPeriod, expiryDate, promotionDate, todayISO, type LeavePeriod } from './policy'

type Admin = SupabaseClient<Database>

/** DM 의 "사용 계획 제출" 버튼 — 값은 leave_promotions.id */
export const PLAN_BUTTON = 'leave_plan_open'
export const PLAN_MODAL_CALLBACK = 'leave_plan_submit'
export const PLAN_FIELD = 'plan'
/** 1차 통보 후 사용 계획 제출 기한 (일) */
export const PLAN_DEADLINE_DAYS = 10

/** 오늘이 몇 차 촉진 기간인지. 1차는 [6개월 전, 2개월 전), 2차는 [2개월 전, 연도 종료] */
export function promotionStageOn(period: LeavePeriod, today: string): 1 | 2 | null {
  if (today > period.end) return null
  if (today >= promotionDate(period, 2)) return 2
  if (today >= promotionDate(period, 1)) return 1
  return null
}

export type PromotionResult = {
  employeeName: string
  stage: 1 | 2
  unusedDays: number
  dmSent: boolean
  planSubmitted: boolean
}

export async function runLeavePromotions(admin: Admin, today: string = todayISO()): Promise<PromotionResult[]> {
  const { data: employees } = await admin
    .from('employees')
    .select('id, name, hired_at, employee_type, work_days, slack_user_id')
    .eq('active', true)
    .eq('employee_type', 'full_time')
    .not('hired_at', 'is', null)

  const results: PromotionResult[] = []

  for (const e of employees ?? []) {
    const period = currentPeriod(e.hired_at!, today)
    if (!period) continue

    const stage = promotionStageOn(period, today)
    if (!stage) continue

    const balance = await getLeaveBalance(admin, e, today)
    if (balance.remaining <= 0) continue

    // 먼저 이력을 선점한다 — 동시에 두 번 돌아도 유니크 제약에 걸린 쪽은 보내지 않는다
    const { data: claimed, error } = await admin
      .from('leave_promotions')
      .insert({
        employee_id: e.id,
        period_start: period.start,
        period_end: period.end,
        stage,
        unused_days: balance.remaining,
      })
      .select('id')
      .single()

    if (error || !claimed) continue // 23505 = 이미 보냄

    // 2차는 1차 때 낸 계획을 함께 보여준다
    let plan: string | null = null
    if (stage === 2) {
      const { data: first } = await admin
        .from('leave_promotions')
        .select('plan_text')
        .eq('employee_id', e.id)
        .eq('period_start', period.start)
        .eq('stage', 1)
        .maybeSingle()
      plan = first?.plan_text ?? null
    }

    const message = buildPromotionMessage({
      promotionId: claimed.id,
      employeeName: e.name,
      stage,
      period,
      unused: balance.remaining,
      pending: balance.pending,
      today,
      plan,
    })

    const posted = e.slack_user_id
      ? await postSlackMessage(e.slack_user_id, message.text, message.blocks)
      : null

    if (posted) {
      await admin.from('leave_promotions').update({ dm_sent: true }).eq('id', claimed.id)
    }

    results.push({
      employeeName: e.name,
      stage,
      unusedDays: balance.remaining,
      dmSent: !!posted,
      planSubmitted: !!plan,
    })
  }

  await notifyAdmins(results, today)
  return results
}

function buildPromotionMessage(p: {
  promotionId: string
  employeeName: string
  stage: 1 | 2
  period: LeavePeriod
  unused: number
  pending: number
  today: string
  plan: string | null
}): { text: string; blocks: SlackBlock[] } {
  const expiry = expiryDate(p.period)
  const pendingNote = p.pending > 0 ? ` (승인 대기 ${p.pending}일 제외)` : ''

  const lines = p.stage === 1
    ? [
        '📢 *[연차 사용 촉진 1차 안내]*',
        `${p.employeeName}님의 미사용 연차를 안내드립니다.`,
        `> 미사용 연차: *${p.unused}일*${pendingNote}`,
        `> 사용 기간: ${p.period.start} ~ ${p.period.end}`,
        `> 소멸 예정일: *${expiry}* — 기간 안에 사용하지 않은 연차는 소멸되며 보상되지 않습니다.`,
        '',
        `근로기준법 제61조에 따른 연차 사용 촉진 안내입니다. *${addDaysISO(p.today, PLAN_DEADLINE_DAYS)}까지* ` +
          '아래 버튼으로 남은 연차의 사용 계획(사용할 날짜)을 제출해주세요.',
        '_실제 사용은 평소처럼 `/연차` 로 신청하면 됩니다._',
      ]
    : [
        '⏰ *[연차 사용 촉진 2차 안내]*',
        `${p.employeeName}님, 아직 사용하지 않은 연차가 있습니다.`,
        `> 미사용 연차: *${p.unused}일*${pendingNote}`,
        `> 사용 기한: *${p.period.end}* 까지 (${expiry} 소멸)`,
        p.plan
          ? `> 제출하신 사용 계획: ${p.plan}`
          : '> 1차 안내 후 사용 계획이 제출되지 않아 회사가 사용 시기를 지정해 통보할 예정입니다.',
        '',
        p.plan
          ? '계획한 날짜에 맞춰 `/연차` 로 신청해주세요.'
          : '원하는 날짜가 있으면 지금 `/연차` 로 신청하거나 아래 버튼으로 사용 계획을 제출해주세요.',
      ]

  const text = lines.join('\n')
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: '사용 계획 제출', emoji: true },
          action_id: PLAN_BUTTON,
          value: p.promotionId,
        }],
      },
    ],
  }
}

/** 관리자 채널 요약 — DM 이 안 간 사람은 서면 통보가 필요하다고 표시한다 */
async function notifyAdmins(results: PromotionResult[], today: string) {
  const channel = process.env.SLACK_LEAVE_CHANNEL
  if (!channel || results.length === 0) return

  const lines = [`📋 *연차 사용 촉진 발송* (${today})`]
  for (const r of results) {
    const flags = [
      r.dmSent ? 'DM 발송' : '⚠️ DM 실패 — Slack 미연결, 서면 통보 필요',
      r.stage === 2 && !r.planSubmitted ? '계획 미제출 → 사용 시기 지정 통보 필요' : '',
    ].filter(Boolean).join(' · ')
    lines.push(`• ${r.employeeName} — ${r.stage}차 · 미사용 ${r.unusedDays}일 · ${flags}`)
  }
  await postSlackMessage(channel, lines.join('\n'))
}

/** 사용 계획 제출 모달 */
export function buildPlanModal(p: {
  promotionId: string
  unused: number
  periodEnd: string
  current: string | null
}): Record<string, unknown> {
  const plain = (text: string) => ({ type: 'plain_text', text, emoji: true })
  return {
    type: 'modal',
    callback_id: PLAN_MODAL_CALLBACK,
    title: plain('연차 사용 계획'),
    submit: plain('제출'),
    close: plain('닫기'),
    private_metadata: p.promotionId,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `미사용 연차 *${p.unused}일*을 *${p.periodEnd}* 까지 언제 사용할지 적어주세요.`,
        },
      },
      {
        type: 'input',
        block_id: PLAN_FIELD,
        label: plain('사용 계획'),
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          initial_value: p.current ?? undefined,
          placeholder: plain('예) 11/14, 12/24~12/26, 1월 둘째 주 금요일'),
        },
      },
    ],
  }
}

export function readPlanSubmission(values: Record<string, Record<string, { value?: string | null }>>): string {
  return (values?.[PLAN_FIELD]?.value?.value ?? '').trim()
}
