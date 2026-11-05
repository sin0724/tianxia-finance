import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PDF 명세서 읽기 — 글꼴 데이터를 node_modules에서 직접 읽으므로 번들하지 않는다
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
