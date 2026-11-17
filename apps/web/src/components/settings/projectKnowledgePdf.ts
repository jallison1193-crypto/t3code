import { joinPdfPagesMarkdown } from "@t3tools/client-runtime/project-memory";
import { openPdf } from "../files/pdfDocument";
import { pdfPageText } from "../files/pdfLayout";

export async function extractPdfTextAsMarkdown(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const loadingTask = openPdf(buffer);
  try {
    const doc = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      try {
        const textContent = await page.getTextContent();
        pages.push(pdfPageText(textContent.items));
      } finally {
        page.cleanup();
      }
    }
    const markdown = joinPdfPagesMarkdown(pages);
    if (markdown.length === 0) {
      throw new Error("Could not extract readable text from this PDF.");
    }
    return markdown;
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}
