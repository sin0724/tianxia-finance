/**
 * PDF 명세서를 엑셀과 같은 표(Grid)로 바꾼다. 텍스트가 있는 PDF만 읽을 수 있다.
 * PDF에는 표가 없고 글자 좌표만 있어서, 머리글 위치를 열 기준으로 삼아 칸을 되살린다.
 */

import path from 'node:path'
import type { Grid } from './statement'

export interface PdfItem { str: string; x: number; y: number; width: number; height: number }

interface Token { text: string; left: number; right: number }

const center = (t: Token) => (t.left + t.right) / 2

function toLines(items: PdfItem[]) {
  const sorted = items.filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: { y: number; size: number; items: PdfItem[] }[] = []
  for (const item of sorted) {
    const line = lines.at(-1)
    if (line && line.y - item.y <= Math.max(2, line.size * 0.4)) line.items.push(item)
    else lines.push({ y: item.y, size: item.height || 8, items: [item] })
  }
  return lines.map((l) => toTokens(l.items.sort((a, b) => a.x - b.x), l.size))
}

/** 붙어 있는 글자 조각을 한 칸으로 합친다. "성   명"처럼 띄어 쓴 머리글은 한 글자씩이어도 합친다 */
function toTokens(items: PdfItem[], size: number) {
  const tokens: Token[] = []
  for (const item of items) {
    const last = tokens.at(-1)
    const gap = last ? item.x - last.right : Infinity
    const spacedLabel = !!last && /^[가-힣]$/.test(last.text.slice(-1)) && /^[가-힣]/.test(item.str.trim()) && last.text.length < 2
    if (last && (gap < size * 0.3 || (spacedLabel && gap < size * 2))) {
      last.text += item.str
      last.right = item.x + item.width
    } else {
      tokens.push({ text: item.str.trim(), left: item.x, right: item.x + item.width })
    }
  }
  return tokens
}

const flatText = (lines: Token[][]) => lines.flat().map((t) => t.text).join('').replace(/\s/g, '')

/** 머리글이 있는 표 페이지면 열 위치를 돌려준다. 직원별 명세서처럼 표가 아니면 null */
function headerAnchors(lines: Token[][]): number[] | null {
  const at = lines.findIndex((l) => /성명|이름|사원명|직원명/.test(flatText([l])))
  if (at < 0) return null
  const zone = lines.slice(at, at + 4)
  const end = zone.findIndex((l) => l.some((t) => /^[\d,]{5,}$/.test(t.text)))
  const header = end < 0 ? zone : zone.slice(0, end)
  const text = flatText(header)
  if (!/소득세/.test(text) || !/차인|실지급|지급합계|지급액/.test(text)) return null
  if (Math.max(...header.map((l) => l.length)) < 5) return null

  const anchors: number[] = []
  for (const x of header.flat().map(center).sort((a, b) => a - b)) {
    if (anchors.length === 0 || x - (anchors.at(-1) as number) > 6) anchors.push(x)
  }
  return anchors
}

function placeOnColumns(line: Token[], anchors: number[]) {
  const row = anchors.map(() => '')
  for (const token of line) {
    let best = 0
    anchors.forEach((a, i) => { if (Math.abs(a - center(token)) < Math.abs(anchors[best] - center(token))) best = i })
    row[best] = row[best] ? `${row[best]} ${token.text}` : token.text
  }
  return row
}

export function itemsToGrid(pages: PdfItem[][]): Grid {
  const grid: Grid = []
  let anchors: number[] | null = null
  for (const items of pages) {
    const lines = toLines(items)
    anchors = headerAnchors(lines) ?? anchors // 머리글이 첫 장에만 있는 표는 앞 장 기준을 이어 쓴다
    for (const line of lines) grid.push(anchors ? placeOnColumns(line, anchors) : line.map((t) => t.text))
  }
  return grid
}

export async function readPdfGrid(data: Uint8Array): Promise<Grid> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const root = path.join(process.cwd(), 'node_modules', 'pdfjs-dist')
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    cMapPacked: true,
    cMapUrl: `${path.join(root, 'cmaps')}${path.sep}`, // 세무 프로그램 PDF의 한글 글꼴 인코딩을 풀 때 쓴다
    standardFontDataUrl: `${path.join(root, 'standard_fonts')}${path.sep}`,
  }).promise

  try {
    const pages: PdfItem[][] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const { items } = await page.getTextContent()
      pages.push(items.flatMap((i) => ('str' in i
        ? [{ str: i.str, x: i.transform[4], y: i.transform[5], width: i.width, height: i.height }]
        : [])))
    }
    return itemsToGrid(pages)
  } finally {
    await doc.destroy()
  }
}
