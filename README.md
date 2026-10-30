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

재무 화면의 원가, 마진, 지출, 급여, 정산은 직원 CRM으로 넘기지 않는다. 스키마는 바꾸지 않고, 기존 테이블을 읽어 API에서만 진행 현황을 만든다.

서버 환경 변수 `STAFF_PROGRESS_SECRET` 을 설정한다. 인증 헤더는 `Authorization: Bearer $STAFF_PROGRESS_SECRET` 이다. `/api` 는 로그인 미들웨어 대상이 아니므로, 시크릿 검사만으로 서버 간 호출을 허용한다.

- `GET /api/integrations/staff-progress?status=ongoing`
  - `status` 는 `ongoing`, `completed`, `cancelled` 중 하나이거나 생략한다.
  - 본문: `{ projects: [...] }`
  - 각 프로젝트 키: `client`, `project`, `status`, `contract_date`, `contract_amount`, `paid_amount`, `items`, `totals`
  - `client` 는 `clients.name` 이다. CRM 담당자는 이 고객명으로 맞춘다.
  - `project` 는 프로젝트명이다.
  - `items` 는 `[{ category, product_name, contracted }]`
  - `totals` 는 `{ contracted }` 이고, 구성 항목 계약 수량의 합이다.
  - `category` 는 연결된 상품의 카테고리(`products.category`)이고, `product_name` 은 `products.name` 이다.
  - `contract_amount` 는 `projects.total_amount` 이다.
  - `paid_amount` 는 그 프로젝트 `payments.amount` 합계다. 확정·예정·환불을 가리지 않는다.
