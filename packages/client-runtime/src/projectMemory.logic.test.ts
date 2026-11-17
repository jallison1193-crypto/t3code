import {
  PROJECT_KNOWLEDGE_FILE_MAX_BYTES,
  PROJECT_KNOWLEDGE_FILE_NAME_MAX_LENGTH,
  PROJECT_KNOWLEDGE_MAX_FILES,
  PROJECT_MEMORY_MAX_BYTES,
  ProjectMemoryRpcError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";
import {
  canAcceptKnowledgeTargetName,
  classifyKnowledgeFile,
  formatMemoryByteSize,
  formatProjectMemoryError,
  joinPdfPagesMarkdown,
  utf8ByteLength,
  validateKnowledgeContentBeforeUpload,
  validateKnowledgeFileNameClient,
  validateMemoryByteLimit,
} from "./projectMemory.ts";

describe("projectMemory helpers", () => {
  it("counts UTF-8 bytes rather than UTF-16 code units", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é🚀")).toBe(6);
    expect(validateMemoryByteLimit("a".repeat(PROJECT_MEMORY_MAX_BYTES)).valid).toBe(true);
    expect(validateMemoryByteLimit("a".repeat(PROJECT_MEMORY_MAX_BYTES + 1)).valid).toBe(false);
  });

  it("formats byte sizes readably", () => {
    expect(formatMemoryByteSize(0)).toBe("0 B");
    expect(formatMemoryByteSize(512)).toBe("512 B");
    expect(formatMemoryByteSize(1536)).toBe("1.5 KB");
    expect(formatMemoryByteSize(2 * 1024 * 1024)).toBe("2 MB");
  });

  it("classifies text, code, PDF, and unsupported files", () => {
    expect(classifyKnowledgeFile({ name: "notes.md", allowPdf: true })).toEqual({
      kind: "text",
      targetName: "notes.md",
    });
    expect(classifyKnowledgeFile({ name: "src/app.ts", allowPdf: false })).toEqual({
      kind: "text",
      targetName: "app.ts",
    });
    expect(classifyKnowledgeFile({ name: "README", allowPdf: false })).toEqual({
      kind: "text",
      targetName: "README",
    });
    expect(
      classifyKnowledgeFile({ name: "spec.pdf", mimeType: "application/pdf", allowPdf: true }),
    ).toEqual({
      kind: "pdf",
      targetName: "spec.pdf.md",
    });
    expect(
      classifyKnowledgeFile({ name: "spec.pdf", mimeType: "application/pdf", allowPdf: false }),
    ).toEqual({
      kind: "unsupported",
      reason: "pdf-unsupported",
    });
    expect(
      classifyKnowledgeFile({ name: "photo.png", mimeType: "image/png", allowPdf: true }),
    ).toEqual({
      kind: "unsupported",
      reason: "unsupported-type",
    });
    expect(classifyKnowledgeFile({ name: "archive.zip", allowPdf: true })).toEqual({
      kind: "unsupported",
      reason: "unsupported-type",
    });
  });

  it("validates knowledge filenames against server rules", () => {
    expect(validateKnowledgeFileNameClient("architecture.md")).toEqual({
      ok: true,
      name: "architecture.md",
    });
    expect(validateKnowledgeFileNameClient("")).toEqual({ ok: false, reason: "empty" });
    expect(validateKnowledgeFileNameClient("..")).toEqual({
      ok: false,
      reason: "invalid_characters",
    });
    expect(validateKnowledgeFileNameClient("foo.staging-1.md")).toEqual({
      ok: false,
      reason: "invalid_characters",
    });
    expect(validateKnowledgeFileNameClient("CON.md")).toEqual({
      ok: false,
      reason: "reserved_name",
    });
    expect(
      validateKnowledgeFileNameClient("a".repeat(PROJECT_KNOWLEDGE_FILE_NAME_MAX_LENGTH + 1)),
    ).toEqual({ ok: false, reason: "too_long" });
  });

  it("enforces file size and max file count while allowing overwrites", () => {
    const fullSet = new Set(
      Array.from({ length: PROJECT_KNOWLEDGE_MAX_FILES }, (_, index) => `doc-${index}.md`),
    );
    expect(canAcceptKnowledgeTargetName("doc-0.md", fullSet)).toBe(true);
    expect(canAcceptKnowledgeTargetName("new-doc.md", fullSet)).toBe(false);

    expect(
      validateKnowledgeContentBeforeUpload({
        targetName: "new-doc.md",
        content: "hello",
        existingNames: fullSet,
      }),
    ).toEqual({ ok: false, reason: "max_files_exceeded" });

    expect(
      validateKnowledgeContentBeforeUpload({
        targetName: "big.md",
        content: "x".repeat(PROJECT_KNOWLEDGE_FILE_MAX_BYTES + 1),
        existingNames: new Set(),
      }),
    ).toEqual({
      ok: false,
      reason: "too_large",
      byteLength: PROJECT_KNOWLEDGE_FILE_MAX_BYTES + 1,
    });
  });

  it("joins extracted PDF pages cleanly", () => {
    expect(joinPdfPagesMarkdown(["  Page 1  \r\nline 2  ", "   ", "Page 2"])).toBe(
      "Page 1  \nline 2\n\nPage 2",
    );
  });

  it("formats ProjectMemoryRpcError including fileName and Effect Cause", () => {
    const rpcErr = new ProjectMemoryRpcError({
      fileName: "notes.md",
      failure: "knowledge_file_too_large",
      message: "File exceeds limit",
    });
    expect(formatProjectMemoryError(rpcErr, "Fallback")).toBe("notes.md: File exceeds limit");
    expect(formatProjectMemoryError(Cause.fail(rpcErr), "Fallback")).toBe(
      "notes.md: File exceeds limit",
    );
    expect(formatProjectMemoryError(new Error("Network lost"), "Fallback")).toBe("Network lost");
    expect(formatProjectMemoryError(null, "Fallback")).toBe("Fallback");
  });
});
