import {
  PROJECT_KNOWLEDGE_FILE_MAX_BYTES,
  PROJECT_KNOWLEDGE_FILE_NAME_MAX_LENGTH,
  PROJECT_KNOWLEDGE_MAX_FILES,
  PROJECT_MEMORY_MAX_BYTES,
  type ProjectKnowledgeFileSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

const textEncoder = new TextEncoder();

const WINDOWS_RESERVED_BASENAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

const SUPPORTED_TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "mdx",
  "txt",
  "text",
  "log",
  "json",
  "jsonc",
  "jsonl",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "sql",
  "graphql",
  "gql",
  "proto",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "psm1",
  "bat",
  "cmd",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "py",
  "pyi",
  "rb",
  "rs",
  "go",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "lua",
  "r",
  "scala",
  "clj",
  "ex",
  "exs",
  "erl",
  "hs",
  "ml",
  "mli",
  "vue",
  "svelte",
  "astro",
  "tex",
  "rst",
  "adoc",
  "org",
  "gitignore",
  "gitattributes",
  "editorconfig",
  "npmrc",
  "nvmrc",
  "prettierrc",
  "eslintrc",
]);

const SUPPORTED_EXTENSIONLESS_NAMES = new Set([
  "README",
  "LICENSE",
  "CHANGELOG",
  "MAKEFILE",
  "DOCKERFILE",
  "PROCFILE",
  "GEMFILE",
  "RAKEFILE",
]);

const KNOWN_BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "tiff",
  "tif",
  "avif",
  "heic",
  "heif",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "aac",
  "m4a",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "zip",
  "tar",
  "gz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "wasm",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "sqlite",
  "db",
]);

const SUPPORTED_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/csv",
  "application/sql",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-sh",
  "application/x-shellscript",
]);

export const WEB_KNOWLEDGE_FILE_INPUT_ACCEPT = [
  ".pdf",
  "application/pdf",
  "text/*",
  ...Array.from(SUPPORTED_TEXT_EXTENSIONS, (ext) => "." + ext),
].join(",");

export function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).byteLength;
}

export function formatMemoryByteSize(bytes: number): string {
  const safe = Math.max(0, Math.floor(bytes));
  if (safe < 1024) return `${safe} B`;
  if (safe < 1024 * 1024) {
    const kb = safe / 1024;
    return `${kb >= 10 ? Math.round(kb) : Number(kb.toFixed(1))} KB`;
  }
  const mb = safe / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(1) : Number(mb.toFixed(2))} MB`;
}

function basenameFromFileName(rawName: string): string {
  const normalized = rawName.trim().split(/[\\/]/).pop() ?? "";
  return normalized.trim();
}

function fileExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot < 0 || lastDot === name.length - 1) return "";
  return name.slice(lastDot + 1).toLowerCase();
}

function isPdfKnowledgeFile(name: string, mimeType?: string | null): boolean {
  const ext = fileExtension(basenameFromFileName(name));
  if (ext === "pdf") return true;
  return (mimeType ?? "").split(";")[0]?.trim().toLowerCase() === "application/pdf";
}

export type KnowledgeFileClassification =
  | { readonly kind: "pdf"; readonly targetName: string }
  | { readonly kind: "text"; readonly targetName: string }
  | {
      readonly kind: "unsupported";
      readonly reason: "empty-name" | "pdf-unsupported" | "unsupported-type";
    };

export function classifyKnowledgeFile(input: {
  readonly name: string;
  readonly mimeType?: string | null;
  readonly allowPdf: boolean;
}): KnowledgeFileClassification {
  const baseName = basenameFromFileName(input.name);
  if (baseName.length === 0) {
    return { kind: "unsupported", reason: "empty-name" };
  }
  if (isPdfKnowledgeFile(baseName, input.mimeType)) {
    if (!input.allowPdf) {
      return { kind: "unsupported", reason: "pdf-unsupported" };
    }
    return { kind: "pdf", targetName: `${baseName}.md` };
  }
  const ext = fileExtension(baseName);
  if (ext.length > 0 && KNOWN_BINARY_EXTENSIONS.has(ext)) {
    return { kind: "unsupported", reason: "unsupported-type" };
  }
  const normalizedMime = (input.mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const isSupportedExtension = ext.length > 0 && SUPPORTED_TEXT_EXTENSIONS.has(ext);
  const isSupportedExtensionless =
    ext.length === 0 && SUPPORTED_EXTENSIONLESS_NAMES.has(baseName.toUpperCase());
  const isDotEnvFile = baseName.toLowerCase().startsWith(".env");
  const isSupportedMime =
    normalizedMime.startsWith("text/") || SUPPORTED_TEXT_MIME_TYPES.has(normalizedMime);

  if (isSupportedExtension || isSupportedExtensionless || isDotEnvFile || isSupportedMime) {
    return { kind: "text", targetName: baseName };
  }
  return { kind: "unsupported", reason: "unsupported-type" };
}

export type KnowledgeFileNameErrorReason =
  | "empty"
  | "too_long"
  | "invalid_characters"
  | "reserved_name";

export function validateKnowledgeFileNameClient(
  rawName: string,
):
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: KnowledgeFileNameErrorReason } {
  const name = rawName.trim();
  if (name.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (name.length > PROJECT_KNOWLEDGE_FILE_NAME_MAX_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  if (name === "." || name === ".." || name.endsWith(".") || name.includes(".staging-")) {
    return { ok: false, reason: "invalid_characters" };
  }
  if (name.includes("/") || name.includes("\\") || name.includes(":")) {
    return { ok: false, reason: "invalid_characters" };
  }
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || '<>"|?*'.includes(name[index]!)) {
      return { ok: false, reason: "invalid_characters" };
    }
  }
  const stem = name.split(".")[0]?.toUpperCase() ?? "";
  if (WINDOWS_RESERVED_BASENAMES.has(stem)) {
    return { ok: false, reason: "reserved_name" };
  }
  return { ok: true, name };
}

export function validateMemoryByteLimit(content: string): {
  readonly byteLength: number;
  readonly maxBytes: number;
  readonly valid: boolean;
} {
  const byteLength = utf8ByteLength(content);
  return {
    byteLength,
    maxBytes: PROJECT_MEMORY_MAX_BYTES,
    valid: byteLength <= PROJECT_MEMORY_MAX_BYTES,
  };
}

export function canAcceptKnowledgeTargetName(
  targetName: string,
  existingNames: ReadonlySet<string>,
  maxFiles = PROJECT_KNOWLEDGE_MAX_FILES,
): boolean {
  return existingNames.has(targetName) || existingNames.size < maxFiles;
}

export function knowledgeNameSet(
  files: ReadonlyArray<Pick<ProjectKnowledgeFileSummary, "name">>,
): Set<string> {
  return new Set(files.map((file) => file.name));
}

export function joinPdfPagesMarkdown(pages: ReadonlyArray<string>): string {
  return pages
    .map((page) => page.replace(/\r\n/g, "\n").trim())
    .filter((page) => page.length > 0)
    .join("\n\n");
}

export function validateKnowledgeContentBeforeUpload(input: {
  readonly targetName: string;
  readonly content: string;
  readonly existingNames: ReadonlySet<string>;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}):
  | { readonly ok: true; readonly name: string; readonly byteLength: number }
  | {
      readonly ok: false;
      readonly reason: KnowledgeFileNameErrorReason | "too_large" | "max_files_exceeded";
      readonly byteLength?: number;
    } {
  const maxBytes = input.maxBytes ?? PROJECT_KNOWLEDGE_FILE_MAX_BYTES;
  const maxFiles = input.maxFiles ?? PROJECT_KNOWLEDGE_MAX_FILES;
  const nameCheck = validateKnowledgeFileNameClient(input.targetName);
  if (!nameCheck.ok) {
    return nameCheck;
  }
  if (!canAcceptKnowledgeTargetName(nameCheck.name, input.existingNames, maxFiles)) {
    return { ok: false, reason: "max_files_exceeded" };
  }
  const byteLength = utf8ByteLength(input.content);
  if (byteLength > maxBytes) {
    return { ok: false, reason: "too_large", byteLength };
  }
  return { ok: true, name: nameCheck.name, byteLength };
}

function readMemoryRpcErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.message !== "string" || record.message.trim().length === 0) {
    return null;
  }
  if (
    record._tag === "ProjectMemoryRpcError" &&
    typeof record.fileName === "string" &&
    record.fileName.trim().length > 0 &&
    !record.message.includes(record.fileName)
  ) {
    return `${record.fileName}: ${record.message}`;
  }
  return record.message;
}

export function formatProjectMemoryError(error: unknown, fallback: string): string {
  if (Cause.isCause(error)) {
    const squashed = Cause.squash(error);
    return formatProjectMemoryError(squashed, fallback);
  }
  const direct = readMemoryRpcErrorMessage(error);
  if (direct !== null) {
    return direct;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}
