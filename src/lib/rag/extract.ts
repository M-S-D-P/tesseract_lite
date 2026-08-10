import path from "path";

// Extract plain text from an uploaded file so the local vector store indexes
// the same content OpenAI's hosted store extracts on its side.
export async function extractText(
  buffer: Buffer,
  filename: string,
  mime?: string
): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf" || mime === "application/pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  // Everything else is treated as UTF-8 text (md, txt, code, csv, json, ...).
  return buffer.toString("utf8");
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml",
  ".xml", ".html", ".pdf", ".docx",
  ".js", ".jsx", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".swift", ".scala", ".sql",
  ".sh", ".bash", ".zsh", ".env", ".toml", ".ini", ".cfg", ".conf",
  ".graphql", ".proto", ".tf", ".vue", ".svelte", ".css", ".scss", ".less",
  ".erb", ".slim", ".haml", ".gemspec", ".rake", ".dockerfile", ".r", ".m",
]);

export function isIngestableFile(filename: string): boolean {
  const base = path.basename(filename).toLowerCase();
  if (["dockerfile", "makefile", "gemfile", "rakefile", "procfile", "readme", "license"].includes(base)) {
    return true;
  }
  return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function isImageFile(filename: string, mime?: string): boolean {
  if (mime?.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}
