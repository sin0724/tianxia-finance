-- 029_incentive_manager_rate.sql
-- 담당자별 기본 인센티브율 — F칸을 비운 줄(과 작업별 구성의 나머지)에 쓰는 비율을 담당자마다 다르게 둔다.
--
--   incentive_managers.default_rate: 새 달 정산표에 넣을 기본율. 비우면 설정의 기본 인센티브율.
--   incentive_months.default_rate:   그 달 정산표의 기본율 (I 기본급처럼 달마다 남긴다). 비우면 설정의 기본 인센티브율.
--
-- 설정에서 담당자 기본율을 바꾸면 새로 만드는 달부터 들어가고, 이미 만든 달은 정산표 위에서 고친다.
-- 표는 027과 같이 관리자만 읽고 쓴다.

ALTER TABLE incentive_managers ADD COLUMN IF NOT EXISTS default_rate numeric(10,8)
  CHECK (default_rate IS NULL OR (default_rate >= 0 AND default_rate <= 1));
ALTER TABLE incentive_months ADD COLUMN IF NOT EXISTS default_rate numeric(10,8)
  CHECK (default_rate IS NULL OR (default_rate >= 0 AND default_rate <= 1));

COMMENT ON COLUMN incentive_managers.default_rate IS '새 달 기본 인센티브율 (0.05 = 5%). 비우면 설정의 기본 인센티브율';
COMMENT ON COLUMN incentive_months.default_rate IS '이 달 기본 인센티브율 — F칸을 비운 줄 · 작업별 구성의 나머지. 비우면 설정의 기본 인센티브율';

-- API(PostgREST)가 새 칸을 바로 알도록
NOTIFY pgrst, 'reload schema';
