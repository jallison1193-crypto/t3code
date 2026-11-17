import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const openPdfMock = vi.fn();

vi.mock("../files/pdfDocument", () => ({
  openPdf: (bytes: Uint8Array) => openPdfMock(bytes),
}));

import { extractPdfTextAsMarkdown } from "./projectKnowledgePdf";

describe("extractPdfTextAsMarkdown (unit)", () => {
  beforeEach(() => {
    openPdfMock.mockReset();
  });

  it("extracts multi-page PDF text into Markdown and destroys loading task", async () => {
    const destroyTask = vi.fn().mockResolvedValue(undefined);
    const cleanupPage1 = vi.fn();
    const cleanupPage2 = vi.fn();

    openPdfMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage: vi.fn(async (pageNumber: number) =>
          pageNumber === 1
            ? {
                getTextContent: async () => ({
                  items: [
                    { str: "Page 1", hasEOL: true },
                    { str: "Overview", hasEOL: false },
                  ],
                }),
                cleanup: cleanupPage1,
              }
            : {
                getTextContent: async () => ({
                  items: [{ str: "Page 2 details", hasEOL: false }],
                }),
                cleanup: cleanupPage2,
              },
        ),
      }),
      destroy: destroyTask,
    });

    const file = new File([new Uint8Array([37, 80, 68, 70])], "spec.pdf", {
      type: "application/pdf",
    });
    const markdown = await extractPdfTextAsMarkdown(file);

    expect(markdown).toBe("Page 1\nOverview\n\nPage 2 details");
    expect(cleanupPage1).toHaveBeenCalledOnce();
    expect(cleanupPage2).toHaveBeenCalledOnce();
    expect(destroyTask).toHaveBeenCalledOnce();
  });

  it("rejects empty PDFs and still destroys task", async () => {
    const destroyTask = vi.fn().mockResolvedValue(undefined);

    openPdfMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn(async () => ({
          getTextContent: async () => ({ items: [{ str: "   ", hasEOL: false }] }),
          cleanup: vi.fn(),
        })),
      }),
      destroy: destroyTask,
    });

    const file = new File([new Uint8Array([37, 80, 68, 70])], "empty.pdf", {
      type: "application/pdf",
    });

    await expect(extractPdfTextAsMarkdown(file)).rejects.toThrow(
      "Could not extract readable text from this PDF.",
    );
    expect(destroyTask).toHaveBeenCalledOnce();
  });
});
