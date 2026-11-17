import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("pdfjs-dist/build/pdf.worker.min.mjs?url"), async () => {
  const { default: source } = await import("pdfjs-dist/build/pdf.worker.min.mjs?raw");
  return {
    default: URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
  };
});

import { extractPdfTextAsMarkdown } from "./projectKnowledgePdf";

function createTestPdfBytes(pages: ReadonlyArray<string>): ArrayBuffer {
  const objects: string[] = [];
  const pageIds: number[] = [];

  // 1: Catalog, 2: Pages, 3: Font
  objects[1] = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  objects[3] = "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";

  let nextId = 4;
  for (const text of pages) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    const stream = text ? `BT /F1 12 Tf 40 700 Td (${text}) Tj ET` : "";
    objects[pageId] =
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`;
    objects[contentId] =
      `${contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  }

  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>\nendobj\n`;

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = body.length;
    body += objects[i];
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(body).slice().buffer;
}

describe("extractPdfTextAsMarkdown", () => {
  it("extracts text across multiple PDF pages into Markdown", async () => {
    const bytes = createTestPdfBytes(["Hello from page one", "Details on page two"]);
    const file = new File([bytes], "guide.pdf", { type: "application/pdf" });

    const markdown = await extractPdfTextAsMarkdown(file);
    expect(markdown).toContain("Hello from page one");
    expect(markdown).toBe("Hello from page one\n\nDetails on page two");
  });

  it("rejects PDFs that contain no extractable text", async () => {
    const bytes = createTestPdfBytes([""]);
    const file = new File([bytes], "blank.pdf", { type: "application/pdf" });

    await expect(extractPdfTextAsMarkdown(file)).rejects.toThrow(
      "Could not extract readable text from this PDF.",
    );
  });
});
