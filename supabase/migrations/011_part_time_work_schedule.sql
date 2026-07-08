-- 아르바이트 근무 일정 (확인용)
-- employees 테이블에 근무요일·근무시간 컬럼 추가
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS work_days TEXT,
  ADD COLUMN IF NOT EXISTS work_start_time TEXT,
  ADD COLUMN IF NOT EXISTS work_end_time TEXT;

COMMENT ON COLUMN employees.work_days IS '근무 요일 (아르바이트 확인용, 쉼표 구분: 예 월,수,금)';
COMMENT ON COLUMN employees.work_start_time IS '근무 시작 시간 (아르바이트 확인용, HH:MM)';
COMMENT ON COLUMN employees.work_end_time IS '근무 종료 시간 (아르바이트 확인용, HH:MM)';
