import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/utils/jwt";
import { prisma } from "@/lib/prisma";
import { errorResponse } from "@/utils/api-response";
import { TOKEN_ONEKI, verifyApiToken, hesapYonetimiUcuMu } from "@/services/api-token.service";

export type AuthenticatedRequest = NextRequest & {
  user: { id: string; name: string; email: string };
};

type CachedUser = { id: string; name: string; email: string };

// Her istekte kullaniciyi DB'den cekmek uzak veritabaninda ~140ms demek ve
// bu bedel TUM endpoint'lere biniyor. Token zaten imzali oldugu icin buradaki
// sorgunun tek isi "kullanici hala var mi" kontrolu; kisa sureli onbellek
// guvenligi bozmadan bu bedeli kaldiriyor.
//
// TTL kisa tutuldu: silinen/degistirilen kullanici en fazla bu sure kadar
// gecerli kalir. Isim degisikligi de ayni surede yansir.
const USER_CACHE_TTL_MS = 30_000;
const userCache = new Map<string, { user: CachedUser; expiresAt: number }>();

async function getUser(userId: string): Promise<CachedUser | null> {
  const cached = userCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });

  if (user) {
    userCache.set(userId, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  } else {
    userCache.delete(userId);
  }
  return user;
}

// Kullanici silindiginde/guncellendiginde onbellegi hemen dusurmek icin
export function invalidateUserCache(userId: string) {
  userCache.delete(userId);
}

export async function authenticate(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("Token gerekli", 401, "UNAUTHORIZED");
  }

  const token = authHeader.slice(7);

  // API anahtari mi JWT mi? On ek ile ayirt ediliyor - tahmin etmeye
  // calismak yerine (JWT parse edip basarisiz olunca API token varsaymak)
  // acik bir isaret kullaniyoruz, boylece hata mesajlari da dogru oluyor:
  // gecersiz bir API anahtari "oturum suresi doldu" demez.
  if (token.startsWith(TOKEN_ONEKI)) {
    let sahip: Awaited<ReturnType<typeof verifyApiToken>>;
    try {
      sahip = await verifyApiToken(token);
    } catch (error) {
      console.error("[auth] API anahtari sorgusu başarısız:", error);
      return errorResponse(
        "Kimlik doğrulama şu anda yapılamıyor, lütfen tekrar deneyin",
        503,
        "AUTH_UNAVAILABLE",
      );
    }

    if (!sahip) {
      return errorResponse("API anahtarı geçersiz veya iptal edilmiş", 401, "INVALID_API_TOKEN");
    }

    // API anahtarinin kapsami/suresi yok; bu yuzden hesap yonetimi uclari
    // (yeni anahtar uretme/iptal, profil guncelleme) anahtarla kapali.
    // Aksi halde sizan bir anahtar kendisiyle ikinci bir anahtar uretip
    // iptalden sonra da erisimini surdurebilirdi.
    // nextUrl testlerdeki sahte isteklerde bulunmayabiliyor; taban veren
    // URL kurucusu hem mutlak hem goreli adreste yolu dogru cikariyor.
    const yol = request.nextUrl?.pathname || new URL(request.url ?? "/", "http://yerel").pathname;
    if (hesapYonetimiUcuMu(yol, request.method)) {
      return errorResponse(
        "Bu işlem API anahtarıyla yapılamaz, oturum açmanız gerekir",
        403,
        "API_TOKEN_FORBIDDEN",
      );
    }

    (request as AuthenticatedRequest).user = sahip;
    return;
  }

  // JWT dogrulamasi (imza/sure) SADECE burada basarisiz olursa gercekten
  // "token gecersiz/suresi dolmus" demektir - 401 dogru.
  let payload: ReturnType<typeof verifyToken>;
  try {
    payload = verifyToken(token);
  } catch {
    return errorResponse("Token süresi dolmuş veya geçersiz", 401, "TOKEN_EXPIRED");
  }

  // getUser (DB sorgusu) burada AYRI try/catch'te: paylasilan Supabase
  // pooler'i gecici olarak dolduğunda (EMAXCONNSESSION) bu sorgu patlar ve
  // eskiden yukaridaki ayni catch'e dusup 401 donuyordu - frontend'deki
  // baseQueryWithLogout da HER 401'de kullaniciyi oturumdan atiyor. Yani
  // gecici bir DB hatasi, tokeni gecerli bir kullaniciyi zorla logout
  // ediyordu. Simdi bu durum 401 DEGIL 503 donuyor, frontend logout
  // tetiklemiyor - kullanici bir sonraki istekte sessizce devam ediyor.
  let user: CachedUser | null;
  try {
    user = await getUser(payload.userId);
  } catch (error) {
    console.error("[auth] Kullanıcı sorgusu başarısız (muhtemelen geçici DB hatası):", error);
    return errorResponse("Kimlik doğrulama şu anda yapılamıyor, lütfen tekrar deneyin", 503, "AUTH_UNAVAILABLE");
  }

  if (!user) {
    return errorResponse("Kullanıcı bulunamadı", 401, "UNAUTHORIZED");
  }

  (request as AuthenticatedRequest).user = user;
}
