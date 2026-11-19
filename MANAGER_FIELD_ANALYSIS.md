# 담당자 필드 변경 영향 분석

## 변경 사항
Slack `/결제` 명령어의 담당자 선택 옵션을 다음 6개로 고정:
- 나병훈 0팀
- 나병훈 1팀
- 이현우 0팀
- 이현우 2팀
- 신현준 0팀
- 이강산 0팀

## 데이터 저장 방식
선택된 값(예: "나병훈 0팀")이 그대로 저장됨:
- Google Sheets F열 (담당자)
- `payments.manager` 필드

## 다운스트림 영향

### 1. ✅ 시트 동기화 (`sync-sheets`)
**영향 없음**. F열을 그대로 읽어서 `payments.manager`에 저장.

### 2. ⚠️ 인센티브 계산 (`src/lib/calculations/incentives.ts`)
**중요한 영향**:
- 현재 코드: `p.manager?.trim().toLowerCase() === e.name.trim().toLowerCase()`
- "나병훈 0팀"은 직원 이름 "나병훈"과 매칭되지 **않음**
- 2026년 10월 이후는 수동 인센티브(`monthly_incentives`)만 사용하므로 영향 없음
- 2026년 9월 이전 데이터의 자동 인센티브 계산에만 영향

**해결 방안**:
- 담당자 필드에서 이름 부분만 추출하여 비교 (`"나병훈 0팀" → "나병훈"`)
- 또는 2026년 10월 이후만 새 형식 사용 (권장하지 않음)

### 3. ✅ 담당자별 실적 (`src/app/(dashboard)/reports/annual/page.tsx`)
**영향 있음 (의도된 동작)**:
- "나병훈 0팀"과 "나병훈 1팀"이 별도 항목으로 집계됨
- 팀별 실적 분석 가능

### 4. ✅ 검색 (`src/app/(dashboard)/payments/page.tsx`)
**영향 없음**. `manager` 필드 텍스트 검색으로 "나병훈"으로 검색하면 "나병훈 0팀", "나병훈 1팀" 모두 찾아짐.

### 5. ✅ Slack 메시지
**영향 없음**. 등록 완료 메시지에 담당자 값이 그대로 표시됨.

### 6. ⚠️ Slack User ID 매핑
**영향 없음** (현재 매핑 없음). 담당자 이름으로 Slack user ID를 찾는 코드가 없음.

## 인센티브 계산 수정 필요

2026년 10월 이전 데이터의 자동 인센티브 계산이 작동하려면 `src/lib/calculations/incentives.ts`를 수정해야 합니다:

```typescript
// 현재
const myPayments = payments.filter(
  (p) => p.manager?.trim().toLowerCase() === e.name.trim().toLowerCase()
)

// 수정안
const myPayments = payments.filter((p) => {
  const manager = p.manager?.trim().toLowerCase() || ''
  const name = e.name.trim().toLowerCase()
  // "나병훈 0팀" → "나병훈"으로 추출하여 비교
  const managerName = manager.split(/\s+/)[0] || manager
  return managerName === name
})
```

하지만 2026년 10월 이후는 수동 인센티브만 사용하므로, 이 수정이 필수는 아닙니다.
