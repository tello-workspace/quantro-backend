import { NextRequest } from "next/server";
import { errorResponse } from "@/utils/api-response";

const WINDOW_MS = 15 * 60 * 1000; // 15 dakika
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

// Aynı IP'den aynı endpoint'e (login/register) kısa sürede çok fazla
// deneme yapılırsa 429 döner. Kaba kuvvetle şifre tahminine karşı.
export function checkRateLimit(request: NextRequest, key: string) {
  const bucketKey = `${key}:${getClientIp(request)}`;
  const now = Date.now();

  const bucket = attempts.get(bucketKey);

  if (!bucket || now > bucket.resetAt) {
    attempts.set(bucketKey, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }

  bucket.count += 1;

  if (bucket.count > MAX_ATTEMPTS) {
    const retryMinutes = Math.ceil((bucket.resetAt - now) / 60000);
    return errorResponse(
      `Çok fazla deneme yaptınız. ${retryMinutes} dakika sonra tekrar deneyin.`,
      429,
      "RATE_LIMITED",
    );
  }

  return null;
}
