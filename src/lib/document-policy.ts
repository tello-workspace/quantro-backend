// Proje belgesi politikasi — tek dogruluk kaynagi. attachment-policy.ts'teki
// ALLOWED_MIME_TYPES ile ayni dosya turlerini kabul eder, ama proje belgeleri
// (sartname, PRD, sozlesme vb.) kart eklerinden buyuk olabildigi icin ayri ve
// daha yuksek bir boyut siniri kullanir.

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB — Supabase bucket limitiyle ayni
export const MAX_DOCUMENTS_PER_PROJECT = 100;

export { ALLOWED_MIME_TYPES } from "./attachment-policy";

// extractText() bu turler icin gercek metin cikarabiliyor; digerleri (gorsel,
// zip, xls/xlsx) ALLOWED_MIME_TYPES'ta kabul edilse de metne cevrilemez —
// MCP'nin read_document'i bu durumda acikca "desteklenmiyor" doner.
export const TEXT_EXTRACTABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/pdf",
  "text/plain",
  "text/csv",
]);
