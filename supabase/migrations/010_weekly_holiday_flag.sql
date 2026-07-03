-- 주휴수당 포함 여부 저장
-- monthly_payroll 테이블에 주휴 포함 플래그 컬럼 추가
ALTER TABLE monthly_payroll
  ADD COLUMN IF NOT EXISTS include_weekly_holiday BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN monthly_payroll.include_weekly_holiday IS '주휴수당 포함 여부 (아르바이트 급여 계산용)';

-- 기존 데이터 백필: 저장된 기본급이 주휴 미포함 금액(시급×시간)과 일치하면 미포함으로 표시
UPDATE monthly_payroll mp
SET include_weekly_holiday = false
FROM employees e
WHERE mp.employee_id = e.id
  AND e.employee_type = 'part_time'
  AND mp.work_hours / 4.345 >= 15
  AND mp.base_salary = ROUND(mp.work_hours * e.hourly_wage);
