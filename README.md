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
  - 각 프로젝트 키: `project_id`, `client_id`, `client_name`, `project_name`, `status`, `contract_date`, `assignee_employee_id`, `assignee_name`, `contract_amount`, `paid_amount`, `items`, `totals`
  - `items` 는 `[{ category, product_name, contracted }]`
  - `totals` 는 `{ contracted }` 이고, 구성 항목 계약 수량의 합이다.
  - `category` 는 연결된 상품의 카테고리(`products.category`)이고, `contract_amount` 는 `projects.total_amount`, `paid_amount` 는 그 프로젝트 `payments.amount` 합계다.
  - `assignee_name` 은 직원 이름만 포함한다.
- `GET /api/integrations/employees`
  - 본문: `{ employees: [{ id, name }] }`
  - 재직 중(`active`) 직원만 반환한다.

프로젝트 관리 화면에서 담당 직원을 지정할 수 있다.
