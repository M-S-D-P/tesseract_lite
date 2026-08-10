import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "sqlite-vec", "pdf-parse", "mammoth", "pg", "pdfkit", "docx", "exceljs"],
  redirects: async () => [{ source: "/knowledge", destination: "/facets", permanent: false }],
  experimental: {
    // proxy.ts buffers request bodies so they can be read twice, capped at 10MB
    // by default. AppMap runtime traces and folder uploads routinely exceed
    // that — past the cap the body is silently truncated and FormData parsing
    // fails with "expected boundary after body".
    proxyClientMaxBodySize: "512mb",
  },
};

export default nextConfig;
