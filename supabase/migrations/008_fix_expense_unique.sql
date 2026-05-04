-- 008_fix_expense_unique.sql
-- monthly_expenses 중복 행 제거 후 unique constraint 추가

-- 1. 중복 행 제거 (category_id별 최신 created_at 행만 남기고 나머지 삭제)
DELETE FROM monthly_expenses
WHERE id NOT IN (
  SELECT DISTINCT ON (year, month, category_id) id
  FROM monthly_expenses
  ORDER BY year, month, category_id, created_at DESC
);

-- 2. unique constraint 추가
ALTER TABLE monthly_expenses
  ADD CONSTRAINT uq_expenses_ym_cat UNIQUE (year, month, category_id);
