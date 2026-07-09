-- 012_gonggu_sales.sql
-- 공구 사업부: 캠페인별 취급액·마진 기록
--
-- 공구는 바이럴마케팅과 달리 실행비가 없고 RS수수료·공급가 마진이 곧 우리 몫이므로
-- 취급액(전체 판매액)과 마진(우리 수익)을 직접 입력해 관리한다.
-- campaign_id는 공구 캠페인 관리 시스템(gonggu-admin) DB의 campaigns.id —
-- 연동된 건은 저장 시 취급액만 관리 시스템으로 동기화된다 (마진은 전송하지 않음).

CREATE TABLE gonggu_sales (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid,                                -- gonggu-admin campaigns.id (수기 입력 시 NULL)
  campaign_name   text NOT NULL,
  client_name     text,
  year            integer NOT NULL,
  month           integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  gross_sales     numeric(14,2) NOT NULL DEFAULT 0,    -- 취급액 (전체 판매액)
  margin          numeric(14,2) NOT NULL DEFAULT 0,    -- 우리 마진 (RS수수료·공급가 마진)
  memo            text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- 연동 캠페인은 월별 1건만 (수기 건은 제한 없음)
CREATE UNIQUE INDEX idx_gonggu_sales_campaign_month
  ON gonggu_sales(campaign_id, year, month) WHERE campaign_id IS NOT NULL;
CREATE INDEX idx_gonggu_sales_month ON gonggu_sales(year, month);

CREATE TRIGGER trg_gonggu_sales_updated_at
  BEFORE UPDATE ON gonggu_sales
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE gonggu_sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON gonggu_sales
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 월별 정산에 공구 실적 반영 (마진만 영업이익에 가산, 취급액은 참고 표기)
ALTER TABLE monthly_settlements
  ADD COLUMN IF NOT EXISTS gonggu_gross_sales numeric(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gonggu_margin      numeric(14,2) DEFAULT 0;
