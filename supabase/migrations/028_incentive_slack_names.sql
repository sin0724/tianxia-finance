-- 028_incentive_slack_names.sql
-- Slack /결제 담당자 목록을 코드 고정 목록 대신 인센티브 정산 설정(담당자 매핑)에서 관리한다.
--
--   담당자마다 Slack /결제 창의 담당자 목록에 보일 이름(예: '이름 0팀')을 적는다.
--   사용 중인 담당자의 이름을 설정 순서대로 보여 주고, 적은 이름은 CRM 담당자명에도 들어가 정산된다.
--   아무 담당자에게도 적지 않았으면 Slack은 코드의 예전 고정 목록을 쓴다.
--
-- 표는 027과 같이 관리자만 읽고 쓴다. Slack 요청은 서버의 서비스 키로 읽는다.

ALTER TABLE incentive_managers ADD COLUMN IF NOT EXISTS slack_names text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN incentive_managers.slack_names IS 'Slack /결제 담당자 목록에 보일 이름 (CRM 담당자명에도 들어간다). 비어 있으면 목록에 안 나온다';

-- API(PostgREST)가 새 칸을 바로 알도록
NOTIFY pgrst, 'reload schema';
