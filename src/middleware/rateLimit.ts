import { NextRequest } from "next/server";
import { errorResponse } from "@/utils/api-response";

const WINDOW_MS = 30 * 1000; // 30 saniye
const MAX_ATTEMPTS = 5;

interface Bucket {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, Bucket>();

// Süresi dolmuş kovaları periyodik temizle (uzun süre çalışan sunucuda bellek şişmesin)
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of attempts) {
    if (now > bucket.resetAt) attempts.delete(key);
  }
}, WINDOW_MS).unref();

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

// Ortak sayac mantigi: kova dolduysa 429 doner, dolmadiysa null.
function consume(bucketKey: string, windowMs: number, max: number, mesaj: (dk: number) => string) {
  const now = Date.now();
  const bucket = attempts.get(bucketKey);

  if (!bucket || now > bucket.resetAt) {
    attempts.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return null;
  }

  bucket.count += 1;

  if (bucket.count > max) {
    const retryMinutes = Math.ceil((bucket.resetAt - now) / 60000);
    return errorResponse(mesaj(retryMinutes), 429, "RATE_LIMITED");
  }

  return null;
}

// Aynı IP'den aynı endpoint'e (login/register) kısa sürede çok fazla
// deneme yapılırsa 429 döner. Kaba kuvvetle şifre tahminine karşı.
export function checkRateLimit(request: NextRequest, key: string) {
  return consume(
    `${key}:${getClientIp(request)}`,
    WINDOW_MS,
    MAX_ATTEMPTS,
    (dk) => `Çok fazla deneme yaptınız. ${dk > 0 ? `${dk} dakika sonra` : 'Biraz sonra'} tekrar deneyin.`,
  );
}

// AI uclari icin limitler. IP degil KULLANICI bazli:
// - Maliyet kullaniciya ait; ayni ofisten (tek IP) calisan ekip ayni butceyi paylasmamali
// - Kayit serbest oldugu icin sinirsiz AI cagrisi, kotayi tuketmenin en kolay yolu
//
// Pencere 15 dk. Degerler normal kullanimi engellemeyecek, ama dongude
// cagirmayi anlamsiz kilacak sekilde secildi.
const AI_LIMITS: Record<string, number> = {
  "ai:chat": 40, // sohbet dogasi geregi patlamali kullanilir
  "ai:fill": 30, // kart basina bir kez
  "ai:insights": 15, // tum panoyu analiz eder, en pahalisi
  "ai:analyze-push": 30, // her git push'ta bir kez
};

const AI_DEFAULT_LIMIT = 20;

// Mesaj bilerek "Quantro AI kullanım sınırı" diyor: ai.service.ts icindeki
// Gemini'nin kendi 429 mesajiyla ("Google Gemini'nin ücretsiz kullanım
// sınırına takıldık...") karistirilmasin - biri bizim limitimiz, digeri
// Google'in kotasi, ikisi farkli sorunlar.
export function checkAiRateLimit(userId: string, key: keyof typeof AI_LIMITS | string) {
  return consume(
    `${key}:user:${userId}`,
    WINDOW_MS,
    AI_LIMITS[key] ?? AI_DEFAULT_LIMIT,
    (dk) => `Quantro AI kullanım sınırına ulaştınız. ${dk} dakika sonra tekrar deneyin.`,
  );
}
