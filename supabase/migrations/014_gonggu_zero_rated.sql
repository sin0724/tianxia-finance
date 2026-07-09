-- 014_gonggu_zero_rated.sql
-- 공구 사업부 영세율(0%) 적용 — 013 부가세 차감 로직 철회
--
-- 공구 셀러는 대만 셀러로 수출에 해당해 부가세 영세율(0%)이 적용된다.
--   · 취급액·마진에 부가세가 붙지 않으므로 납부용으로 떼어놓을 부가세가 없다.
--   · 정산 시 마진 전액이 영업이익에 가산된다.
--   · 국내 매입 시 부담한 매입부가세는 오히려 환급 대상.

ALTER TABLE monthly_settlements
  DROP COLUMN IF EXISTS gonggu_margin_supply;

COMMENT ON COLUMN monthly_settlements.gonggu_margin      IS '공구 마진 (영세율 0% — 전액 영업이익 가산)';
COMMENT ON COLUMN monthly_settlements.gonggu_gross_sales IS '공구 취급액 (영세율 0%, 참고 표기 — 영업이익 미포함)';
