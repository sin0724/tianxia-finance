This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## 직원용 프로젝트 진행 피드

재무 화면의 원가, 마진, 지출, 급여, 정산은 직원 CRM으로 넘기지 않는다. 진행 현황은 뷰 `staff_project_progress` 와 아래 API만 사용한다.

`supabase/migrations/025_staff_project_progress.sql` 을 데이터베이스에 적용한 뒤, 서버 환경 변수 `STAFF_PROGRESS_SECRET` 을 설정한다. 이 변경을 배포하는 것만으로 운영 데이터베이스 마이그레이션이 적용되지는 않는다.

인증 헤더는 `Authorization: Bearer $STAFF_PROGRESS_SECRET` 이다. `/api` 는 로그인 미들웨어 대상이 아니므로, 시크릿 검사만으로 서버 간 호출을 허용한다.

- `GET /api/integrations/staff-progress?status=ongoing&assignee=<직원 UUID 또는 이름>`
  - 본문: `{ projects: [...] }`
  - 각 프로젝트 키: `project_id`, `client_id`, `client_name`, `project_name`, `status`, `contract_date`, `assignee_employee_id`, `assignee_name`, `contract_amount`, `paid_amount`, `items`, `contracted`, `delivered`, `remaining`
  - `items` 는 `[{ project_item_id, category, product_name, contracted, delivered, remaining }]`
  - `category` 는 연결된 상품의 카테고리(`products.category`)이고, `contract_amount` 는 `projects.total_amount`, `paid_amount` 는 그 프로젝트 `payments.amount` 합계다.
  - `assignee_name` 은 직원 이름만 포함한다.
- `POST /api/integrations/deliveries`
  - 본문: `project_item_id` 또는 `project_id` + `category`, 그리고 `quantity`(1 이상의 정수). 선택 값은 `delivered_at`(`YYYY-MM-DD`, 없으면 한국 오늘), `note`, `external_key`.
  - 응답은 `{ delivery, idempotent }` 이고, `delivery` 키는 `id`, `project_item_id`, `quantity`, `delivered_at`, `note`, `source`, `external_key`, `created_at` 뿐이다.
  - 같은 `external_key` 가 이미 있으면 기존 납품 행을 바꾸지 않고 그대로 반환한다.
  - `category` 가 한 프로젝트 안에서 여러 구성 항목과 맞으면 `project_item_id` 로 다시 지정한다.
- `GET /api/integrations/employees`
  - 본문: `{ employees: [{ id, name }] }`
  - 재직 중(`active`) 직원만 반환한다.

프로젝트 관리 화면에서 담당 직원을 지정하고, 구성 항목마다 납품을 기록하거나 삭제할 수 있다. 계약 수량, 납품 수량, 잔여 수량을 함께 보여 준다.
