-- 019_break_time_and_absence.sql
-- 아르바이트 급여 산정 정밀화 — 휴게시간 · 포괄시급 · 결근
--
-- 그동안 알바 급여는 "월 근무시간을 사람이 타이핑 → × 시급 → 주휴 20% 가산"이 전부였다.
-- 세 가지가 빠져 있었다.
--
--   ① 휴게시간   점심이 있는 직원과 없는 직원을 구분할 수 없었다. 09:00~18:00 근무자가
--                점심 1시간이면 8시간, 아니면 9시간인데 그 차이를 매달 입력자가 암산해서
--                넣어야 했고 근거는 어디에도 남지 않았다. (근로기준법 제54조: 4시간 근로에
--                30분, 8시간 근로에 1시간 이상의 휴게시간을 근로시간 도중에 주어야 하며 무급이다)
--
--   ② 포괄시급   시급 자체에 주휴수당을 녹여 지급하는 계약이 있는데 앱은 전원에게 주휴를
--                따로 얹고 있었다. 그 직원은 매달 사람이 체크박스를 꺼야 했다.
--
--   ③ 결근       주휴수당은 그 주의 소정근로일을 개근해야 발생한다(근로기준법 제55조).
--                결근을 기록할 곳이 없어 결근한 주의 주휴까지 지급되고 있었다.
--
-- 011에서 넣은 work_days / work_start_time / work_end_time 은 "확인용" 표시 필드였으나
-- 이번부터 실제 산정 근거가 된다. 휴게시간이 합쳐지면서 하루 소정근로시간이 확정되고,
-- 그 달에 해당 요일이 몇 번 오는지로 월 소정근로일수가 나오므로 주휴를 월 평균 근사가
-- 아니라 주 단위로 계산할 수 있다.

-- ── 직원 마스터 ──────────────────────────────────────────────
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS break_minutes         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wage_includes_holiday boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN employees.break_minutes IS
  '1일 무급 휴게시간(분). 점심 1시간이면 60, 휴게 없이 근무하면 0. '
  '하루 소정근로시간 = (근무 종료 − 근무 시작) − 휴게시간';
COMMENT ON COLUMN employees.wage_includes_holiday IS
  '시급에 주휴수당이 이미 포함된 계약(포괄시급)이면 true. true면 주휴를 따로 더하지 않는다. '
  '주 40시간 이하에서 주휴는 소정근로시간의 20%이므로 실질 기본시급 = 시급 ÷ 1.2 이며, '
  '이 값이 최저임금에 못 미치면 최저임금법 위반이다';

-- 011의 "확인용" 주석을 산정 근거로 갱신한다
COMMENT ON COLUMN employees.work_days       IS '근무 요일 (쉼표 구분: 예 월,수,금). 월 소정근로일수·주 소정근로시간 산정에 쓰인다';
COMMENT ON COLUMN employees.work_start_time IS '근무 시작 시각 (HH:MM). 휴게시간과 함께 하루 소정근로시간을 만든다';
COMMENT ON COLUMN employees.work_end_time   IS '근무 종료 시각 (HH:MM). 시작보다 이르면 자정을 넘긴 야간 근무로 본다';

-- ── 월별 급여 ────────────────────────────────────────────────
ALTER TABLE monthly_payroll
  ADD COLUMN IF NOT EXISTS absent_days numeric(4,1) NOT NULL DEFAULT 0;

COMMENT ON COLUMN monthly_payroll.absent_days IS
  '이 달 결근 일수 (반일 결근은 0.5). 결근한 주는 주휴수당이 발생하지 않는다. '
  '연차·유급휴일·회사 사정에 의한 휴업은 결근이 아니므로 여기 넣지 않는다. '
  'work_hours 는 결근을 뺀 실근무시간이므로 결근이 시급분에서 두 번 차감되지 않는다';

COMMENT ON COLUMN monthly_payroll.work_hours IS
  '이 달 실제 근무한 시간 (휴게시간·결근 제외). 근무 일정이 등록된 직원은 '
  '하루 소정근로시간 × (월 소정근로일수 − 결근일수) 로 자동 산출할 수 있다';

DO $$ BEGIN
  ALTER TABLE monthly_payroll
    ADD CONSTRAINT monthly_payroll_absent_days_check CHECK (absent_days >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE employees
    ADD CONSTRAINT employees_break_minutes_check CHECK (break_minutes >= 0 AND break_minutes < 1440);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 백필은 하지 않는다.
-- break_minutes 기본값 0 은 "휴게 없음"이 아니라 "아직 설정하지 않음"과 구분되지 않지만,
-- 지금까지 work_hours 는 사람이 휴게시간을 빼고 넣어온 값이므로 과거 급여 기록은 이미 맞다.
-- 이번 달부터 직원별 휴게시간을 설정하면 그때부터 자동 산출이 정확해진다.
