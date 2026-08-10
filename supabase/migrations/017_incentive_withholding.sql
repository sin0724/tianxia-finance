-- 017_incentive_withholding.sql
-- 인센티브 원천징수를 incentive_income_tax / incentive_local_tax 로 일원화
--
-- 그동안 incentive_deductions 한 칸에 "인센티브 3.3% 공제액"을 넣어왔다.
-- 016에서 인센티브분 소득세·지방소득세 칸이 생겼으므로 같은 숫자를 담는 칸이 둘이 됐고,
-- 사업소득지급대장은 3.3%를 소득세(3%) / 지방소득세(소득세의 10%)로 쪼개 요구하므로
-- 한 칸짜리 합계로는 대장을 채울 수 없다. 기존 값을 두 칸으로 이관하고 옛 칸을 폐기한다.
--
-- 또한 그동안 정산에서 인센티브 비용을 "인센티브 − 공제액"(= 세후)으로 잡고 있었다.
-- 원천징수세는 직원이 부담하나 회사가 대신 납부하는 돈이므로 인건비 비용은 세전 기준이다.
-- 이 마이그레이션 이후 정산은 인센티브 세전액을 비용으로 잡는다 → 과거 월을 재계산하면
-- 영업이익이 공제액만큼 낮아진다(그동안 과대계상돼 있었다).

-- ── 기존 공제액을 소득세 / 지방소득세로 분해 ──────────────────
-- 지방소득세 = 소득세 × 10% 이므로 총액 = 소득세 × 1.1
-- 소득세 = 내림(총액 ÷ 1.1, 10원 단위), 지방소득세 = 총액 − 소득세
UPDATE monthly_payroll
SET incentive_income_tax = floor(incentive_deductions / 1.1 / 10) * 10,
    incentive_local_tax  = incentive_deductions - floor(incentive_deductions / 1.1 / 10) * 10
WHERE incentive_deductions > 0
  AND COALESCE(incentive_income_tax, 0) = 0
  AND COALESCE(incentive_local_tax, 0) = 0;

-- 이관 완료 후 옛 칸은 0으로 비운다 (컬럼 자체는 롤백 여지를 두고 남긴다)
UPDATE monthly_payroll
SET incentive_deductions = 0
WHERE incentive_deductions > 0;

COMMENT ON COLUMN monthly_payroll.incentive_deductions IS
  '[DEPRECATED 017] 인센티브 3.3% 공제액이었으나 incentive_income_tax / incentive_local_tax 로 이관됨. 더 이상 읽거나 쓰지 않는다.';

COMMENT ON COLUMN monthly_payroll.incentive_income_tax IS
  '인센티브분 소득세 (3%) — 대장 인센티브 줄의 소득세';
COMMENT ON COLUMN monthly_payroll.incentive_local_tax IS
  '인센티브분 지방소득세 (소득세의 10%) — 대장 인센티브 줄의 지방소득세';
