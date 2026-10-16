-- 022_absent_memo.sql
-- 급여 산정의 결근 일수에 메모를 붙인다
--
-- 019에서 넣은 monthly_payroll.absent_days 는 숫자뿐이라, 나중에 보면 언제·왜 결근했는지
-- 알 수 없었다. 주휴 소멸은 직원에게 설명해야 하는 차감이므로 근거를 같은 행에 남긴다.
-- 계산에는 쓰지 않는 기록용 필드다.

ALTER TABLE monthly_payroll
  ADD COLUMN IF NOT EXISTS absent_memo text;

COMMENT ON COLUMN monthly_payroll.absent_memo IS
  '결근 날짜·사유 메모 (예: 10/3 무단, 10/17 오전 병원). 기록용이며 계산에는 쓰지 않는다';
