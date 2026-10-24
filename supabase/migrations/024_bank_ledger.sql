-- 024_bank_ledger.sql
-- 통장·카드 내역 기반 월 마감
--
-- 그동안 월별 지출을 "월 × 항목" 합계로 손으로 넣고, 실행비는 단가표 원가로 추정해 정산했다.
-- 그 결과 대출금이 매출로, 배당·보증금·타사업자 세금이 비용으로 섞이고, 원천세가 급여와 이중으로
-- 빠지는 일이 생겼다(2026-10 통장 대조 결과). 이제 정산의 원본을 통장·카드 내역으로 바꾼다.
--
--   ① 월말에 통장 거래내역(CSV)·카드 승인내역(XLS)을 올린다 → bank_transactions / card_transactions
--   ② 거래마다 분류(category)가 자동으로 붙는다 — 사용자 규칙(classification_rules) → 기본 규칙 순
--   ③ 매출 입금은 결제 내역(payments)과 자동 매칭되고, 수금 예정 건은 입금 확인으로 확정된다
--   ④ 정산 = 통장 매출 − 통장·카드 비용 + 급여(세무사 대장 기준) — 손익 외 항목(대출·배당·보증금·
--      가수금·타사업자 대납·법인 부가세)과 현금 이동(급여 지급·원천세·카드대금)은 비용에서 빠진다
--   ⑤ 월초 잔액 + 입금 − 출금 = 월말 잔액 을 검증해 정산과 함께 저장한다

-- ─────────────────────────────────────────────────────────
-- 1. 업로드 기록
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS statement_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('bank', 'card')),
  filename      text,
  period_start  date,
  period_end    date,
  total_rows    int NOT NULL DEFAULT 0,
  inserted      int NOT NULL DEFAULT 0,
  skipped       int NOT NULL DEFAULT 0,   -- 이미 올린 거래 (중복)
  imported_at   timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────
-- 2. 통장 거래
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_transactions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_at              timestamptz NOT NULL,
  tx_date            date NOT NULL,                 -- KST 거래일
  seq                bigint NOT NULL,               -- 같은 시각 거래 순서 (파일 순서, 오래된 순 증가)
  counterparty       text NOT NULL DEFAULT '',      -- 보낸분/받는분
  memo               text NOT NULL DEFAULT '',      -- 내 통장 표시
  kind               text NOT NULL DEFAULT '',      -- 적요
  branch             text NOT NULL DEFAULT '',      -- 처리점
  withdrawal         numeric(14,0) NOT NULL DEFAULT 0,
  deposit            numeric(14,0) NOT NULL DEFAULT 0,
  balance            numeric(14,0) NOT NULL,
  cancelled          boolean NOT NULL DEFAULT false, -- 은행 "취소/취소된거래" 쌍 — 잔액에는 반영, 정산에서는 제외
  category           text NOT NULL DEFAULT 'unclassified',
  classified_by      text NOT NULL DEFAULT 'rule' CHECK (classified_by IN ('rule', 'user_rule', 'manual')),
  attribution_month  date,                          -- 귀속월(1일) — 비우면 거래월. 예: 4대보험 "2609" → 2026-09-01
  payment_id         uuid REFERENCES payments(id) ON DELETE SET NULL,
  note               text,
  import_id          uuid REFERENCES statement_imports(id) ON DELETE SET NULL,
  row_hash           text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_tx_date ON bank_transactions (tx_date, seq);
CREATE INDEX IF NOT EXISTS idx_bank_tx_category ON bank_transactions (category);
CREATE INDEX IF NOT EXISTS idx_bank_tx_payment ON bank_transactions (payment_id);

DROP TRIGGER IF EXISTS trg_bank_tx_updated_at ON bank_transactions;
CREATE TRIGGER trg_bank_tx_updated_at
  BEFORE UPDATE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────────────────────
-- 3. 카드 승인
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS card_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approved_at      timestamptz NOT NULL,
  approved_date    date NOT NULL,
  card_last4       text NOT NULL DEFAULT '',
  merchant         text NOT NULL DEFAULT '',
  industry         text NOT NULL DEFAULT '',
  amount_krw       numeric(14,0),                 -- 국내 승인 (취소는 음수)
  amount_foreign   numeric(12,2),                 -- 해외 승인 USD (취소는 음수)
  vat              numeric(14,0) NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT '',      -- 정상 / 승인취소
  approval_no      text NOT NULL DEFAULT '',
  is_check_card    boolean NOT NULL DEFAULT false, -- 체크카드 — 통장에서 바로 출금된다
  category         text NOT NULL DEFAULT 'card_expense',
  excluded         boolean NOT NULL DEFAULT false, -- 개인 사용 등 법인 비용이 아닌 건
  note             text,
  import_id        uuid REFERENCES statement_imports(id) ON DELETE SET NULL,
  row_hash         text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_card_tx_date ON card_transactions (approved_date);

-- ─────────────────────────────────────────────────────────
-- 4. 사용자 분류 규칙 — 거래 분류를 손으로 고칠 때 "앞으로도 이렇게"를 고르면 생긴다
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS classification_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty  text,          -- 보낸분/받는분 (정확히 일치, 비우면 무시)
  memo_contains text,          -- 통장 메모에 포함 (비우면 무시)
  direction     text NOT NULL DEFAULT 'any' CHECK (direction IN ('in', 'out', 'any')),
  category      text NOT NULL,
  priority      int NOT NULL DEFAULT 100,  -- 낮을수록 먼저
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (counterparty IS NOT NULL OR memo_contains IS NOT NULL)
);

-- ─────────────────────────────────────────────────────────
-- 5. 직원 통장 표시 이름 — 앱 이름과 통장 예금주가 다른 경우 (예: 활동명과 예금주가 다름, 외국인 직원 영문 표기)
-- ─────────────────────────────────────────────────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_name text;
COMMENT ON COLUMN employees.bank_name IS '통장 예금주 표시 (비우면 이름과 같음) — 통장 급여 이체를 직원과 연결할 때 쓴다';

-- 값은 직원별로 직원 관리(또는 SQL)에서 넣는다 — 실명이 들어가므로 마이그레이션에 두지 않는다

-- ─────────────────────────────────────────────────────────
-- 6. 정산 결과 — 통장 기준 정산 표시와 잔액 검증
-- ─────────────────────────────────────────────────────────
ALTER TABLE monthly_settlements
  ADD COLUMN IF NOT EXISTS basis          text NOT NULL DEFAULT 'manual' CHECK (basis IN ('manual', 'bank')),
  ADD COLUMN IF NOT EXISTS cash_opening   numeric(14,0),  -- 월초 통장 잔액
  ADD COLUMN IF NOT EXISTS cash_closing   numeric(14,0),  -- 월말 통장 잔액
  ADD COLUMN IF NOT EXISTS cash_in        numeric(14,0),  -- 월 입금 합계 (취소 제외)
  ADD COLUMN IF NOT EXISTS cash_out       numeric(14,0),  -- 월 출금 합계 (취소 제외)
  ADD COLUMN IF NOT EXISTS non_pl_in      numeric(14,0) DEFAULT 0,  -- 손익 외 입금 (대출·가수금·환급 등)
  ADD COLUMN IF NOT EXISTS non_pl_out     numeric(14,0) DEFAULT 0,  -- 손익 외 출금 (배당·보증금·부가세·대납 등)
  ADD COLUMN IF NOT EXISTS card_fx_rate   numeric(10,2),  -- 해외 카드 원화 환산 환율
  ADD COLUMN IF NOT EXISTS breakdown      jsonb;          -- 분류별 금액 (리포트 상세 표시용)

COMMENT ON COLUMN monthly_settlements.basis IS 'manual = 월별 지출 수기 입력 기준(이전 방식), bank = 통장·카드 내역 기준(월 마감)';

-- ─────────────────────────────────────────────────────────
-- 7. RLS — 기존 테이블과 동일 (로그인한 관리자만)
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['statement_imports', 'bank_transactions', 'card_transactions', 'classification_rules']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "authenticated_all" ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY "authenticated_all" ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      tbl
    );
  END LOOP;
END $$;
