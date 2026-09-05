import { NextRequest } from "next/server";
import { errorResponse } from "@/utils/api-response";

// In-memory idempotency store
// Aynı anda gelen duplicate istekleri engellemek için kullanılır.
// Key formatı: "userId:path:bodyHash"
// - İlk istek gelince kayda "processing" olarak işlenir
// - Aynı key ile HÂLÂ işlenmekte olan bir istek varsa ikinci istek 409 Conflict döner
// - İlk istek bitince kayıt "done" olur ve artık blok etmez; aynı gövdeyle
//   atılan meşru bir sonraki istek normal işlenir
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
  // Sadece hâlâ işlenmekte olan bir kayıt çift istek sayılır. "done" kaydı,
  // ilk isteğin çoktan bittiği anlamına gelir; aynı gövdeyle atılan MEŞRU
  // ikinci istek (ör. aynı karta 5 sn arayla iki kez "tamam" yorumu, etiketi
  // çıkarıp geri ekleme) 409 ile reddedilmemeli.
  if (existing && existing.status === "processing") {
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
 * Kayıt 10 saniye daha "done" olarak durur ama artık yeni istekleri bloklamaz;
 * sadece gecikmeli temizlik için tutulur.
 */
export function clearIdempotency(key: string): void {
  const record = store.get(key);
  if (record) {
    record.status = "done";
    // Gecikmeli temizlik, aradan geçen YENİ bir "processing" kaydını silmemeli:
    // aksi halde biten isteğin zamanlayıcısı, aynı key ile başlamış sonraki
    // isteğin çift tıklama korumasını erkenden düşürür.
    setTimeout(() => {
      const current = store.get(key);
      if (current && current.status === "done") {
        store.delete(key);
      }
    }, 10_000).unref();
  }
}

/**
 * Hata durumunda idempotency kaydını anında temizler.
 */
export function failIdempotency(key: string): void {
  store.delete(key);
}
