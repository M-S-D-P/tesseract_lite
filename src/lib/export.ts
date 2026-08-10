import PDFDocument from "pdfkit";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
} from "docx";

// Markdown → PDF/DOCX export for chat answers. Handles headings, paragraphs,
// bullet/numbered lists, fenced code, and pipe tables — the shapes the models
// actually produce.

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "numbered"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; rows: string[][] };

function stripInline(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: stripInline(heading[2]) });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i]
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => stripInline(c.trim()));
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      if (rows.length > 0) blocks.push({ kind: "table", rows });
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    if (bullet) {
      blocks.push({ kind: "bullet", text: stripInline(bullet[1]) });
      i++;
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (numbered) {
      blocks.push({ kind: "numbered", text: stripInline(numbered[1]) });
      i++;
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    // paragraph: absorb consecutive non-empty plain lines
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}\s|```|\s*[-*]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "para", text: stripInline(para.join(" ")) });
  }
  return blocks;
}

export async function markdownToPdf(md: string, title: string): Promise<Buffer> {
  const blocks = parseMarkdown(md);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(16).text(title);
    doc.moveDown(0.8);

    for (const b of blocks) {
      switch (b.kind) {
        case "heading":
          doc
            .font("Helvetica-Bold")
            .fontSize(15 - b.level)
            .text(b.text);
          doc.moveDown(0.4);
          break;
        case "para":
          doc.font("Helvetica").fontSize(10.5).text(b.text, { lineGap: 2 });
          doc.moveDown(0.5);
          break;
        case "bullet":
          doc.font("Helvetica").fontSize(10.5).text(`•  ${b.text}`, { indent: 12, lineGap: 2 });
          doc.moveDown(0.15);
          break;
        case "numbered":
          doc.font("Helvetica").fontSize(10.5).text(`–  ${b.text}`, { indent: 12, lineGap: 2 });
          doc.moveDown(0.15);
          break;
        case "code": {
          doc.moveDown(0.2);
          doc.font("Courier").fontSize(8.5).fillColor("#333333");
          doc.text(b.text, { lineGap: 1 });
          doc.fillColor("black");
          doc.moveDown(0.5);
          break;
        }
        case "table": {
          doc.moveDown(0.2);
          const colCount = Math.max(...b.rows.map((r) => r.length));
          const tableWidth = doc.page.width - 108;
          const colWidth = tableWidth / colCount;
          for (let r = 0; r < b.rows.length; r++) {
            const y = doc.y;
            let maxH = 0;
            for (let c = 0; c < colCount; c++) {
              const text = b.rows[r][c] ?? "";
              doc
                .font(r === 0 ? "Helvetica-Bold" : "Helvetica")
                .fontSize(9)
                .text(text, 54 + c * colWidth + 3, y + 3, { width: colWidth - 6 });
              maxH = Math.max(maxH, doc.heightOfString(text, { width: colWidth - 6 }) + 6);
            }
            for (let c = 0; c <= colCount; c++) {
              doc
                .moveTo(54 + c * colWidth, y)
                .lineTo(54 + c * colWidth, y + maxH)
                .strokeColor("#cccccc")
                .stroke();
            }
            doc
              .moveTo(54, y)
              .lineTo(54 + tableWidth, y)
              .stroke();
            doc.y = y + maxH;
            doc.x = 54;
          }
          doc
            .moveTo(54, doc.y)
            .lineTo(54 + tableWidth, doc.y)
            .stroke();
          doc.moveDown(0.6);
          break;
        }
      }
    }
    doc.end();
  });
}

export async function markdownToDocx(md: string, title: string): Promise<Buffer> {
  const blocks = parseMarkdown(md);
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
  ];
  const HEADINGS = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
  ] as const;
  for (const b of blocks) {
    switch (b.kind) {
      case "heading":
        children.push(
          new Paragraph({ text: b.text, heading: HEADINGS[Math.min(b.level, 4) - 1] })
        );
        break;
      case "para":
        children.push(new Paragraph({ children: [new TextRun(b.text)] }));
        break;
      case "bullet":
        children.push(new Paragraph({ text: b.text, bullet: { level: 0 } }));
        break;
      case "numbered":
        children.push(
          new Paragraph({ text: b.text, numbering: { reference: "num", level: 0 } })
        );
        break;
      case "code":
        for (const line of b.text.split("\n")) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: line || " ", font: "Courier New", size: 17 })],
              shading: { fill: "F4F4F4" },
            })
          );
        }
        break;
      case "table": {
        const rows = b.rows.map(
          (r, ri) =>
            new TableRow({
              children: r.map(
                (cell) =>
                  new TableCell({
                    children: [
                      new Paragraph({
                        children: [new TextRun({ text: cell, bold: ri === 0 })],
                      }),
                    ],
                  })
              ),
            })
        );
        children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(new Paragraph({ text: "" }));
        break;
      }
    }
  }
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "num",
          levels: [{ level: 0, format: "decimal", text: "%1.", start: 1 }],
        },
      ],
    },
    sections: [{ children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
