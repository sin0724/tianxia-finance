-- 027_incentive_settlement.sql
-- 담당자 인센티브 정산을 정산시트(구글 시트 + Apps Script) 방식 그대로 앱에서 한다.
--
-- 접근 권한
--   다른 표는 로그인한 사람 모두가 읽고 쓴다(authenticated_all). 이 마이그레이션의 표는
--   app_admins 에 등록된 계정만 읽고 쓸 수 있다. 서버 코드도 같은 검사를 한 번 더 한다.
--   관리자 등록은 저장소에 이메일을 남기지 않도록 SQL 편집기에서 따로 실행한다:
--     SELECT id, email FROM auth.users;                       -- 계정 확인
--     INSERT INTO app_admins (user_id)
--       SELECT id FROM auth.users WHERE email = '관리자 로그인 이메일';
--
-- 표와 정산시트의 대응
--   incentive_settings   설정 탭 (VAT율 · 기본 인센티브율 · 기본급 · 완납 상태 · 환수 지급률 · 인정률 구간)
--   incentive_managers   설정 탭 담당자 매핑 (정산 탭 이름 ↔ CRM 담당자명)
--   incentive_months     "{담당자} {N}월" 탭의 2행 요약 (I 기본급 · K 특별수당 · L 비고)
--   incentive_lines      월 탭의 A~G 줄과 숨김 P(동기화ID) · Q(CRM 날짜)
--   incentive_clawbacks  환수내역 탭
--   incentive_carryovers 앱으로 옮기기 전 월 탭에서 이미 인센을 잡은 입금액 (잔금 · 분납 계산용)

-- ── 관리자 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_admins (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 정책을 두지 않는다: 로그인 사용자도 이 표를 직접 읽거나 쓸 수 없다.
ALTER TABLE app_admins ENABLE ROW LEVEL SECURITY;

-- 지금 로그인한 계정이 관리자인지만 알려 준다 (다른 계정 정보는 돌려주지 않는다)
CREATE OR REPLACE FUNCTION is_app_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.app_admins WHERE user_id = auth.uid())
$$;
REVOKE ALL ON FUNCTION is_app_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION is_app_admin() FROM anon;
GRANT EXECUTE ON FUNCTION is_app_admin() TO authenticated;

-- ── 설정 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incentive_settings (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  vat_rate      numeric(6,4)  NOT NULL DEFAULT 0.1,
  default_rate  numeric(10,8) NOT NULL DEFAULT 0.2,
  default_base  bigint        NOT NULL DEFAULT 2000000,
  full_statuses text[]        NOT NULL DEFAULT ARRAY['입금완료'],
  paid_rate     numeric(10,8) NOT NULL DEFAULT 0.2,
  tiers         jsonb         NOT NULL DEFAULT
    '[{"min":0,"rate":5},{"min":30,"rate":5},{"min":50,"rate":10},{"min":70,"rate":15},{"min":100,"rate":20}]',
  updated_at    timestamptz   NOT NULL DEFAULT now()
);
INSERT INTO incentive_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN incentive_settings.full_statuses IS 'CRM 입금상태 중 완납으로 보는 값. 그 외 상태(미입금 제외)는 잔금 건';
COMMENT ON COLUMN incentive_settings.paid_rate IS '환수 계산의 이미 지급한 인센티브 비율 (설정 탭 기본 지급률)';
COMMENT ON COLUMN incentive_settings.tiers IS '환수 인정률 구간: 진행률(%) 이상 → 인정 인센티브율(%)';

-- ── 담당자 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incentive_managers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text   NOT NULL UNIQUE,
  crm_names   text[] NOT NULL,
  base_salary bigint,
  sort_order  int    NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN incentive_managers.name IS '정산 탭 이름';
COMMENT ON COLUMN incentive_managers.crm_names IS 'CRM 결제시트 담당자 열에 적히는 이름들';
COMMENT ON COLUMN incentive_managers.base_salary IS '새 달 기본급. 비우면 설정의 기본급';

-- ── 월 (탭 2행 요약) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS incentive_months (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id        uuid NOT NULL REFERENCES incentive_managers(id) ON DELETE CASCADE,
  year              int  NOT NULL,
  month             int  NOT NULL CHECK (month BETWEEN 1 AND 12),
  base_salary       bigint NOT NULL,
  special_allowance bigint,
  summary_note      text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at         timestamptz,
  snapshot          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manager_id, year, month)
);
COMMENT ON COLUMN incentive_months.snapshot IS '마감할 때의 H~O 요약 값';

-- ── 정산 줄 (탭 A~G · P · Q) ─────────────────────────────
CREATE TABLE IF NOT EXISTS incentive_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id  uuid NOT NULL,
  year        int  NOT NULL,
  month       int  NOT NULL,
  position    int  NOT NULL,
  client_name text NOT NULL DEFAULT '',
  sales       bigint,
  paid        bigint,
  rate        text,
  note        text NOT NULL DEFAULT '',
  sync_id     text,
  crm_date    date,
  kind        text NOT NULL DEFAULT 'manual' CHECK (kind IN ('contract', 'balance', 'installment', 'manual')),
  fill        text CHECK (fill IN ('red', 'yellow', 'green')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (manager_id, year, month)
    REFERENCES incentive_months (manager_id, year, month) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_incentive_lines_sync
  ON incentive_lines (manager_id, year, month, sync_id) WHERE sync_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_incentive_lines_month
  ON incentive_lines (manager_id, year, month, position);

COMMENT ON COLUMN incentive_lines.sales IS 'B 매출 (VAT 포함)';
COMMENT ON COLUMN incentive_lines.paid IS 'D 인센 기준 입금액 (VAT 포함). 비우면 B 전액 기준, 0이면 인센 0';
COMMENT ON COLUMN incentive_lines.rate IS 'F 인센티브율. 비우면 기본율. "20%" · "230400/2700000" 같은 숫자 또는 작업별 혼합 구성 글';
COMMENT ON COLUMN incentive_lines.sync_id IS 'P CRM 동기화ID. 잔금·분납 줄은 {ID}#{월}';
COMMENT ON COLUMN incentive_lines.kind IS 'contract: CRM 계약 줄 / balance: (잔금) / installment: (분납) / manual: 손으로 추가';

-- ── 환수내역 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incentive_clawbacks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id      uuid NOT NULL,
  year            int  NOT NULL,
  month           int  NOT NULL,
  client_name     text NOT NULL,
  direct_amount   bigint,
  contract_amount bigint,
  progress        numeric(6,2),
  memo            text NOT NULL DEFAULT '',
  registered_on   date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (manager_id, year, month)
    REFERENCES incentive_months (manager_id, year, month) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_incentive_clawbacks_month ON incentive_clawbacks (manager_id, year, month);

COMMENT ON COLUMN incentive_clawbacks.direct_amount IS 'D 환수액(직접입력). 있으면 계산 대신 이 값';
COMMENT ON COLUMN incentive_clawbacks.contract_amount IS 'E 계약금액 (VAT 포함)';
COMMENT ON COLUMN incentive_clawbacks.progress IS 'H 진행률(%)';

-- ── 앱 도입 전 정산분 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS incentive_carryovers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id   uuid NOT NULL REFERENCES incentive_managers(id) ON DELETE CASCADE,
  base_sync_id text NOT NULL,
  origin_year  int  NOT NULL,
  origin_month int  NOT NULL,
  client_name  text NOT NULL DEFAULT '',
  sales        bigint,
  origin_note  text NOT NULL DEFAULT '',
  origin_fill  text CHECK (origin_fill IN ('red', 'yellow', 'green')),
  settled      bigint NOT NULL DEFAULT 0,
  paid_count   int    NOT NULL DEFAULT 0,
  source       text   NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manager_id, base_sync_id)
);
COMMENT ON TABLE incentive_carryovers IS '정산시트 월 탭에서 CRM 건별로 이미 인센을 잡은 입금액 합계. 원래 줄은 D(없으면 B), 잔금·분납 줄은 D';

-- ── updated_at ───────────────────────────────────────────
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'incentive_settings', 'incentive_managers', 'incentive_months',
    'incentive_lines', 'incentive_clawbacks', 'incentive_carryovers'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
      tbl, tbl
    );
  END LOOP;
END $$;

-- ── RLS: 관리자만 ────────────────────────────────────────
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'incentive_settings', 'incentive_managers', 'incentive_months',
    'incentive_lines', 'incentive_clawbacks', 'incentive_carryovers'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "admin_only" ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY "admin_only" ON %I FOR ALL TO authenticated USING ((SELECT is_app_admin())) WITH CHECK ((SELECT is_app_admin()))',
      tbl
    );
  END LOOP;
END $$;
