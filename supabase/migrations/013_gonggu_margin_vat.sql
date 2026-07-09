-- 013_gonggu_margin_vat.sql
-- 공구 사업부 부가세 반영
--
-- 취급액·마진 모두 부가세(VAT) 포함 수취액 기준으로 입력한다.
--   · 마진: 정산 시 공급가액(마진 ÷ 1.1)만 영업이익에 가산하고,
--     부가세분(마진 − 공급가액)은 납부용으로 구분한다.
--   · 취급액: 셀러 결제액(VAT 포함) 그대로 참고 표기 — 영업이익 미포함.
--     취급액에 포함된 매출부가세는 매입세액공제를 거치면 실제 납부액이
--     마진 부가세와 같아지므로 정산에서 따로 떼어놓지 않는다.

ALTER TABLE monthly_settlements
  ADD COLUMN IF NOT EXISTS gonggu_margin_supply numeric(14,2) DEFAULT 0;  -- 공구 마진 공급가액 (영업이익 가산분)

COMMENT ON COLUMN monthly_settlements.gonggu_margin        IS '공구 마진 (VAT 포함 수취액)';
COMMENT ON COLUMN monthly_settlements.gonggu_margin_supply IS '공구 마진 공급가액 (마진 ÷ (1+VAT), 영업이익 가산분)';
COMMENT ON COLUMN monthly_settlements.gonggu_gross_sales   IS '공구 취급액 (VAT 포함, 참고 표기 — 영업이익 미포함)';

-- 기존 저장분은 마진 전액이 영업이익에 가산된 구버전 계산이므로 backfill하지 않는다.
-- (gonggu_margin_supply = 0 인 행은 리포트에서 구버전 형식으로 표시되며, 재계산 시 갱신됨)
