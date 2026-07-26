import { NextRequest } from "next/server";
import { errorResponse } from "@/utils/api-response";

// In-memory idempotency store
// Aynı anda gelen duplicate istekleri engellemek için kullanılır.
// Key formatı: "userId:path:bodyHash"
// - İlk istek gelince kayda "processing" olarak işlenir
// - Aynı key ile ikinci istek gelirse 409 Conflict döner
// - 10 saniye sonra otomatik temizlenir

interface IdempotencyRecord {
  status: "processing" | "done";
  timestamp: number;
}

const store = new Map<string, IdempotencyRecord>();

// Periyodik temizlik (her 30 saniyede bir)
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of store) {
    if (now - record.timestamp > 30_000) {
      store.delete(key);
    }
  }
}, 30_000).unref();

/**
 * İstek için basit bir hash oluşturur.
 * userId + path + body içeriğinden unique bir key üretir.
 */
function generateKey(userId: string, path: string, body: unknown): string {
  const bodyStr = JSON.stringify(body);
  let hash = 0;
  const input = `${userId}:${path}:${bodyStr}`;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return `idem:${userId}:${path}:${hash}`;
}

/**
 * Idempotency kontrolü yapar.
 *
 * @param request - Next.js request nesnesi
 * @param userId - Authenticate olmuş kullanıcı ID'si
 * @param body - Request body'si (opsiyonel, POST/PATCH için)
 * @returns { key: string } | Response (409 ise Response döner)
 *
 * Kullanım:
 *   const idem = checkIdempotency(request, user.id, body);
 *   if (idem instanceof Response) return idem; // duplicate yakalandı
 *   // ... işlem yap ...
 *   clearIdempotency(idem.key); // işlem bitince temizle
 */
export function checkIdempotency(
  request: NextRequest,
  userId: string,
  body?: unknown,
): { key: string } | Response {
  const path = request.nextUrl?.pathname || request.url || "";
  const key = generateKey(userId, path, body);

  const existing = store.get(key);
  if (existing) {
    const elapsed = Date.now() - existing.timestamp;
    console.log(
      `[IDEMPOTENCY] Duplicate request blocked: key=${key.substring(0, 60)}... elapsed=${elapsed}ms`,
    );
    return errorResponse(
      "Bu istek zaten işleniyor. Lütfen bekleyin.",
      409,
      "DUPLICATE_REQUEST",
    );
  }

  // İlk istek — kayda geç
  store.set(key, { status: "processing", timestamp: Date.now() });

  return { key };
}

/**
 * İşlem başarılı veya başarısız olduktan sonra idempotency kaydını temizler.
 * Kayıt 10 saniye daha "done" olarak kalır ki aynı key ile gelen
 * gecikmiş duplicate'ler de yakalansın.
 */
export function clearIdempotency(key: string): void {
  const record = store.get(key);
  if (record) {
    record.status = "done";
    // 10 saniye sonra tamamen temizle
    setTimeout(() => store.delete(key), 10_000).unref();
  }
}

/**
 * Hata durumunda idempotency kaydını anında temizler.
 */
export function failIdempotency(key: string): void {
  store.delete(key);
}
