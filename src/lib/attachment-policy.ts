// Ek dosya politikasi — tek dogruluk kaynagi (single source of truth).
// Hem route hem service buradan okur; frontend'teki karsiligi olan
// sabitler (imageCompression.ts) gorsel kategorileri aynen yansitir.

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB — Supabase bucket limitiyle ayni
export const MAX_IMAGE_DIMENSION = 2048; // en uzun kenar (px): pano/kart gosterimi icin fazlasi
export const IMAGE_QUALITY = 82; // WebP kalitesi — gorsel olarak fark edilmez, ~2-4x kucultur
export const MAX_ATTACHMENTS_PER_CARD = 20; // kart basina ek siniri (belirtim dışı kotayi kapatir)

export const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  // image/svg+xml bilerek YOK: SVG script tasiyabilir ve tarayicida inline
  // render edilirse XSS riski olusturur (güvenlik bulgusu 10).
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
]);

// WebP'e yeniden kodlanip sikistirilabilir kaynaklar (alfa kanali korunur)
export const COMPRESSIBLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
]);

// Zaten sikistirilmis gorseller: boyut limitini asiyorsa sadece boyutlandirilir
export const RESIZE_ONLY_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/webp"]);

// Dokunulmadan gecen gorseller: GIF animasyonlu olabilir (sharp kare atar).
// SVG artik allowlist'te olmadigi icin burada da yok (bkz. ALLOWED_MIME_TYPES).
export const PASSTHROUGH_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/gif",
]);
