/**
 * 서버 시작 시 1회 호출된다 (Next.js instrumentation).
 * 결제시트 → DB 자동 동기화 스케줄러를 여기서 띄운다 — Railway 단일 인스턴스로 `next start` 가
 * 계속 떠 있으므로 별도 cron 서비스 없이 프로세스 안의 타이머로 충분하다.
 *
 * - production + Node.js 런타임에서만 동작 (개발 서버·edge 에서는 돌지 않는다)
 * - SHEET_SYNC_INTERVAL_MIN: 주기(분). 기본 15, 최소 5, '0' 이면 끈다
 * - 부팅 약 60초 뒤 첫 실행, 이후 주기마다 실행
 */

const DEFAULT_INTERVAL_MIN = 15
const MIN_INTERVAL_MIN = 5
const FIRST_RUN_DELAY_MS = 60_000

type SchedulerState = {
  interval?: ReturnType<typeof setInterval>
  firstRun?: ReturnType<typeof setTimeout>
}

// 핫 리로드·register 중복 호출에도 타이머가 하나만 남도록 globalThis 에 보관한다
const STATE_KEY = Symbol.for('tianxia.sheetSync.scheduler')
const holder = globalThis as { [STATE_KEY]?: SchedulerState }

function parseIntervalMin(raw: string | undefined): number {
  const n = Number(raw)
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(n)) return DEFAULT_INTERVAL_MIN
  return Math.max(MIN_INTERVAL_MIN, n)
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NODE_ENV !== 'production') return
  const raw = process.env.SHEET_SYNC_INTERVAL_MIN
  if (raw?.trim() === '0') return

  const intervalMin = parseIntervalMin(raw)

  // 이미 떠 있는 타이머는 정리하고 새로 건다 (두 개가 동시에 돌지 않게)
  const prev = holder[STATE_KEY]
  if (prev?.interval) clearInterval(prev.interval)
  if (prev?.firstRun) clearTimeout(prev.firstRun)

  const tick = async () => {
    try {
      // edge 런타임이 googleapis 를 불러오지 않도록 동적 import
      const { runSheetSyncLocked, isSyncFailure, isSyncSkipped } = await import('./lib/sheets-sync')
      const r = await runSheetSyncLocked({ trigger: 'cron' })
      if (isSyncSkipped(r)) {
        console.log('[sheet-sync] cron skipped (already running)')
      } else if (isSyncFailure(r)) {
        console.error(`[sheet-sync] cron error ${r.error}`)
      } else {
        console.log(`[sheet-sync] cron ok synced=${r.synced} updated=${r.updated} skipped=${r.skipped} pending=${r.pending}`)
      }
    } catch (e) {
      // 타이머 밖으로 예외가 새면 프로세스가 죽을 수 있다 — 여기서 모두 삼킨다
      console.error(`[sheet-sync] cron error ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const state: SchedulerState = {}
  state.firstRun = setTimeout(() => { void tick() }, FIRST_RUN_DELAY_MS)
  state.interval = setInterval(() => { void tick() }, intervalMin * 60_000)
  // 타이머가 프로세스 종료를 막지 않게
  state.firstRun.unref?.()
  state.interval.unref?.()
  holder[STATE_KEY] = state

  console.log(`[sheet-sync] scheduler started interval=${intervalMin}min`)
}
