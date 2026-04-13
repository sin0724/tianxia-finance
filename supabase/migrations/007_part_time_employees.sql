-- 아르바이트 시급 지원
-- employees 테이블에 직원 타입과 시급 컬럼 추가
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS employee_type TEXT NOT NULL DEFAULT 'full_time'
    CHECK (employee_type IN ('full_time', 'part_time')),
  ADD COLUMN IF NOT EXISTS hourly_wage INTEGER NOT NULL DEFAULT 0;

-- monthly_payroll 테이블에 근무 시간 컬럼 추가
ALTER TABLE monthly_payroll
  ADD COLUMN IF NOT EXISTS work_hours NUMERIC(6, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN employees.employee_type IS '직원 구분: full_time=정직원, part_time=아르바이트';
COMMENT ON COLUMN employees.hourly_wage IS '시급 (아르바이트 전용, 원)';
COMMENT ON COLUMN monthly_payroll.work_hours IS '월 근무 시간 (아르바이트 급여 계산용)';
