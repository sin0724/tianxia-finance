-- 015_payment_status_sync_logs.sql
-- 1) 결제 상태를 memo 이모지 태그 → 정식 컬럼으로 전환
-- 2) 시트 동기화 로그 테이블
-- 3) 앱 환경설정(알림 다시 안보기 등) 테이블
-- 4) 입금 확정 / 결제 자동 생성 RPC (원자성 보장)

-- ─────────────────────────────────────────────────────────
-- 1. payments.status / payments.excluded
-- ─────────────────────────────────────────────────────────
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'balance_due', 'unpaid')),
  ADD COLUMN IF NOT EXISTS excluded boolean NOT NULL DEFAULT false;

-- 기존 memo 태그 백필
UPDATE payments SET status = 'balance_due' WHERE memo LIKE '%⚠ 잔금 처리 요망%';
UPDATE payments SET status = 'unpaid'      WHERE memo LIKE '%🔴 미입금%';
UPDATE payments SET excluded = true        WHERE memo LIKE '%🚫 집계 제외%';

-- memo에서 태그 제거 (구분자 ' | ' 정리 포함)
UPDATE payments
SET memo = NULLIF(
  trim(
    regexp_replace(
      regexp_replace(
        replace(replace(replace(memo, '⚠ 잔금 처리 요망', ''), '🔴 미입금', ''), '🚫 집계 제외', ''),
        '\s*\|\s*\|\s*', ' | ', 'g'   -- 태그 제거로 생긴 이중 구분자
      ),
      '^\s*\|\s*|\s*\|\s*$', '', 'g'  -- 앞뒤 구분자
    )
  ),
  ''
)
WHERE memo LIKE '%⚠ 잔금 처리 요망%'
   OR memo LIKE '%🔴 미입금%'
   OR memo LIKE '%🚫 집계 제외%';

CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_payment_date ON payments (payment_date);

-- ─────────────────────────────────────────────────────────
-- 2. sync_logs — 시트 동기화 실행 기록 (마지막 동기화 표시용)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  trigger text NOT NULL DEFAULT 'manual',   -- manual | cron
  from_date date,
  synced int NOT NULL DEFAULT 0,
  updated int NOT NULL DEFAULT 0,
  skipped int NOT NULL DEFAULT 0,
  created_projects int NOT NULL DEFAULT 0,
  pending int NOT NULL DEFAULT 0,
  unmatched int NOT NULL DEFAULT 0,
  error text
);

ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON sync_logs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────
-- 3. app_prefs — 기기 간 공유되는 앱 설정 (대시보드 알림 다시안보기 등)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_prefs (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_prefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON app_prefs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────
-- 4. RPC: 입금 확정 (업데이트 + 잔여분 생성을 한 트랜잭션으로)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION confirm_pending_payment(
  p_payment_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_project_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_orig payments%ROWTYPE;
  v_remainder numeric;
BEGIN
  SELECT * INTO v_orig FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '결제 내역을 찾을 수 없습니다';
  END IF;

  UPDATE payments SET
    amount       = p_amount,
    payment_date = p_payment_date,
    project_id   = p_project_id,
    matched      = (p_project_id IS NOT NULL),
    status       = 'confirmed'
  WHERE id = p_payment_id;

  -- 부분 입금 — 차액을 원래 상태의 수금 예정 건으로 남긴다
  v_remainder := v_orig.amount - p_amount;
  IF v_remainder > 0.01 THEN
    INSERT INTO payments (
      project_id, amount, payment_date, payment_type, manager,
      memo, source, client_name_raw, matched, status
    ) VALUES (
      p_project_id, v_remainder, v_orig.payment_date, v_orig.payment_type, v_orig.manager,
      v_orig.memo, v_orig.source, v_orig.client_name_raw,
      (p_project_id IS NOT NULL),
      CASE WHEN v_orig.status = 'confirmed' THEN 'balance_due' ELSE v_orig.status END
    );
  END IF;

  RETURN jsonb_build_object('remainder', GREATEST(v_remainder, 0));
END $$;

-- ─────────────────────────────────────────────────────────
-- 5. RPC: 결제 추가 + 클라이언트·프로젝트 자동 생성 (원자성 보장)
--    잔여 결제가 남은 프로젝트(진행중 우선 → 완료의 잔금)에만 합치고,
--    없으면 재계약으로 보고 새 프로젝트를 생성한다.
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION add_payment_with_auto_project(
  p_amount numeric,
  p_payment_date date,
  p_payment_type text DEFAULT NULL,
  p_manager text DEFAULT NULL,
  p_memo text DEFAULT NULL,
  p_client_name text DEFAULT NULL,
  p_project_id uuid DEFAULT NULL,
  p_status text DEFAULT 'confirmed'
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_client_id uuid;
  v_project_id uuid := p_project_id;
  v_prior_count int := 0;
  v_created_project boolean := false;
  v_payment_id uuid;
  v_name text := NULLIF(trim(coalesce(p_client_name, '')), '');
BEGIN
  IF v_project_id IS NULL AND v_name IS NOT NULL THEN
    -- 클라이언트 찾기 또는 생성
    SELECT id INTO v_client_id FROM clients WHERE lower(name) = lower(v_name) LIMIT 1;
    IF v_client_id IS NULL THEN
      INSERT INTO clients (name, manager) VALUES (v_name, NULLIF(trim(coalesce(p_manager, '')), ''))
      RETURNING id INTO v_client_id;
    END IF;

    SELECT count(*) INTO v_prior_count
    FROM projects WHERE client_id = v_client_id AND status <> 'cancelled';

    -- 잔여 결제가 남은 프로젝트 찾기 (진행중 우선 → 완료)
    SELECT p.id INTO v_project_id
    FROM projects p
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(amount), 0) AS paid FROM payments WHERE project_id = p.id
    ) pay ON true
    WHERE p.client_id = v_client_id
      AND p.status IN ('ongoing', 'completed')
      AND pay.paid < p.total_amount
    ORDER BY CASE p.status WHEN 'ongoing' THEN 0 ELSE 1 END, p.created_at DESC
    LIMIT 1;

    IF v_project_id IS NULL THEN
      INSERT INTO projects (client_id, name, total_amount, contract_date, status, memo)
      VALUES (
        v_client_id,
        CASE WHEN v_prior_count > 0 THEN v_name || ' (재계약 ' || v_prior_count || '차)' ELSE v_name END,
        p_amount, p_payment_date, 'ongoing',
        CASE WHEN v_prior_count > 0 THEN '재계약 (자동 생성)' ELSE NULL END
      ) RETURNING id INTO v_project_id;
      v_created_project := true;
    END IF;
  END IF;

  INSERT INTO payments (
    project_id, amount, payment_date, payment_type, manager,
    memo, source, client_name_raw, matched, status
  ) VALUES (
    v_project_id, p_amount, p_payment_date,
    NULLIF(trim(coalesce(p_payment_type, '')), ''),
    NULLIF(trim(coalesce(p_manager, '')), ''),
    NULLIF(trim(coalesce(p_memo, '')), ''),
    'manual', v_name,
    (v_project_id IS NOT NULL),
    coalesce(NULLIF(p_status, ''), 'confirmed')
  ) RETURNING id INTO v_payment_id;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'project_id', v_project_id,
    'created_project', v_created_project
  );
END $$;
