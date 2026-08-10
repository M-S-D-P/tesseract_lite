import fs from "fs";
import path from "path";
import ExcelJS from "exceljs";
import { getDb, uid, UPLOADS_DIR } from "./db";
import { markdownToDocx, markdownToPdf } from "./export";

// The generate_file chat tool: models produce real downloadable artifacts —
// Excel workbooks, CSV, Word, PDF, Markdown — attached to the answer.

export type FileSpec = {
  filename: string;
  format: "xlsx" | "csv" | "docx" | "pdf" | "md";
  sheets?: { name?: string; rows: (string | number)[][] }[];
  markdown?: string;
  title?: string;
};

const MIME: Record<FileSpec["format"], string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  md: "text/markdown",
};

const GENERATED_DIR = path.join(UPLOADS_DIR, "generated");

async function buildXlsx(spec: FileSpec): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheets = spec.sheets?.length ? spec.sheets : [{ name: "Sheet1", rows: [[""]] }];
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    const ws = wb.addWorksheet((s.name || `Sheet${i + 1}`).slice(0, 31));
    const rows = s.rows ?? [];
    for (const row of rows) ws.addRow(row);
    // Header styling + sensible column widths
    if (rows.length > 0) {
      const header = ws.getRow(1);
      header.font = { bold: true, color: { argb: "FFFFFFFF" } };
      header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB91C1C" } };
      header.alignment = { vertical: "middle" };
      header.height = 20;
      const colCount = Math.max(...rows.map((r) => r.length));
      for (let c = 1; c <= colCount; c++) {
        const lengths = rows.map((r) => String(r[c - 1] ?? "").length);
        ws.getColumn(c).width = Math.min(60, Math.max(12, Math.max(...lengths) + 2));
        ws.getColumn(c).alignment = { wrapText: true, vertical: "top" };
      }
      ws.views = [{ state: "frozen", ySplit: 1 }];
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: colCount },
      };
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function buildCsv(spec: FileSpec): Buffer {
  const rows = spec.sheets?.[0]?.rows ?? [];
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return Buffer.from(rows.map((r) => r.map(esc).join(",")).join("\n"), "utf8");
}

export async function generateFile(
  orgId: string,
  threadId: string | null,
  spec: FileSpec
): Promise<{ id: string; name: string; url: string }> {
  if (!spec.filename || !spec.format || !MIME[spec.format]) {
    throw new Error("filename and a valid format (xlsx|csv|docx|pdf|md) are required");
  }
  let buffer: Buffer;
  switch (spec.format) {
    case "xlsx":
      if (!spec.sheets?.length) throw new Error("xlsx requires sheets[] with rows");
      buffer = await buildXlsx(spec);
      break;
    case "csv":
      if (!spec.sheets?.length) throw new Error("csv requires sheets[0].rows");
      buffer = buildCsv(spec);
      break;
    case "docx":
      if (!spec.markdown) throw new Error("docx requires markdown content");
      buffer = await markdownToDocx(spec.markdown, spec.title ?? spec.filename);
      break;
    case "pdf":
      if (!spec.markdown) throw new Error("pdf requires markdown content");
      buffer = await markdownToPdf(spec.markdown, spec.title ?? spec.filename);
      break;
    case "md":
      if (!spec.markdown) throw new Error("md requires markdown content");
      buffer = Buffer.from(spec.markdown, "utf8");
      break;
  }

  const id = uid();
  let name = spec.filename.replace(/[\/\\]/g, "_").slice(0, 120);
  if (!name.toLowerCase().endsWith(`.${spec.format}`)) name = `${name}.${spec.format}`;
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const rel = path.join("generated", `${id}-${name}`);
  fs.writeFileSync(path.join(UPLOADS_DIR, rel), buffer);
  getDb()
    .prepare(
      "INSERT INTO generated_files (id, org_id, thread_id, name, path, mime) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, orgId, threadId, name, rel, MIME[spec.format]);
  return { id, name, url: `/api/files/${id}` };
}

export function loadGeneratedFile(id: string, orgId: string) {
  const row = getDb()
    .prepare("SELECT name, path, mime FROM generated_files WHERE id = ? AND org_id = ?")
    .get(id, orgId) as { name: string; path: string; mime: string } | undefined;
  if (!row) return null;
  try {
    return { ...row, buffer: fs.readFileSync(path.join(UPLOADS_DIR, row.path)) };
  } catch {
    return null;
  }
}

export const FILE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    filename: { type: "string", description: "e.g. migration-plan.xlsx" },
    format: { type: "string", enum: ["xlsx", "csv", "docx", "pdf", "md"] },
    sheets: {
      type: "array",
      description:
        "For xlsx/csv: worksheets. First row of each sheet is the header row.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          rows: {
            type: "array",
            items: { type: "array", items: { type: ["string", "number"] } },
          },
        },
        required: ["rows"],
      },
    },
    markdown: {
      type: "string",
      description: "For docx/pdf/md: full document content as markdown.",
    },
    title: { type: "string", description: "Document title (docx/pdf)." },
  },
  required: ["filename", "format"],
} as const;

export const FILE_TOOL_DESCRIPTION =
  "Generate a downloadable file for the user: Excel workbook (xlsx, multi-sheet with styled headers), CSV, Word (docx), PDF, or Markdown. Use whenever the user asks for a spreadsheet, workbook, plan file, report document, or export. The file is attached to your answer automatically — after calling, briefly describe what the file contains.";
