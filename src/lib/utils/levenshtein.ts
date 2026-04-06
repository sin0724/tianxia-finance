/** Levenshtein distance between two strings (case-insensitive) */
export function levenshtein(a: string, b: string): number {
  const s1 = a.toLowerCase()
  const s2 = b.toLowerCase()
  const m = s1.length
  const n = s2.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = s1[i - 1] === s2[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

/** Similarity score 0~1 (1 = identical) */
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

/** Find top-N similar strings from candidates */
export function findSimilar(
  query: string,
  candidates: { id: string; name: string }[],
  topN = 3,
  threshold = 0.4,
): { id: string; name: string; score: number }[] {
  return candidates
    .map((c) => ({ ...c, score: similarity(query, c.name) }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
}
