import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { ValidationError, NotFoundError } from "@/utils/errors";

// Kullanici basina API anahtari. MCP server ve diger dis araclar bununla
// kimlik doguluyor.
//
// Guvenlik dengesi: ham token DB'de tutulmuyor, yalnizca sha256 hash'i.
// Bu, PasswordResetToken/EmailVerificationToken ile ayni desen. Fark su:
// sifre sifirlama token'i tek kullanimlik ve 1 saatlik, bu ise suresiz ve
// sinirsiz kullanimlik - bu yuzden IPTAL edilebilir olmasi sart.
//
// Neden bcrypt degil sha256: parola hash'lerinde bcrypt'in yavasligi kaba
// kuvvete karsi bir OZELLIK, cunku parolalar dusuk entropili. Burada token
// 256 bit rastgele - kaba kuvvet zaten imkansiz. Buna karsilik bu hash HER
// API isteginde hesaplanacak; bcrypt kullanmak her istege ~100ms eklerdi.

export const TOKEN_ONEKI = "qtr_";

/** Arayuzde anahtari tanimaya yarayan, duz metin saklanan on ek. */
const GORUNEN_UZUNLUK = 8;

function hashle(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface ApiTokenOzeti {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface OlusturulanToken extends ApiTokenOzeti {
  /** Ham token - YALNIZCA olusturma yanitinda, bir kez doner. */
  token: string;
}

export async function createApiToken(userId: string, name: string): Promise<OlusturulanToken> {
  const temizAd = name.trim();
  if (!temizAd) {
    throw new ValidationError("Anahtar adı zorunludur");
  }
  if (temizAd.length > 100) {
    throw new ValidationError("Anahtar adı en fazla 100 karakter olabilir");
  }

  // Kullanici basina ust sinir: kaybolan/unutulan anahtarlarin sinirsiz
  // birikmesini onler. Iptal edilenler sayilmiyor.
  const mevcutSayi = await prisma.apiToken.count({
    where: { userId, revokedAt: null },
  });
  if (mevcutSayi >= 10) {
    throw new ValidationError(
      "En fazla 10 aktif API anahtarınız olabilir. Kullanmadıklarınızı iptal edin.",
    );
  }

  const ham = `${TOKEN_ONEKI}${crypto.randomBytes(32).toString("hex")}`;
  const kayit = await prisma.apiToken.create({
    data: {
      userId,
      name: temizAd,
      tokenHash: hashle(ham),
      prefix: ham.slice(0, TOKEN_ONEKI.length + GORUNEN_UZUNLUK),
    },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true },
  });

  return { ...kayit, token: ham };
}

export async function listApiTokens(userId: string): Promise<ApiTokenOzeti[]> {
  return prisma.apiToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true },
  });
}

export async function revokeApiToken(userId: string, tokenId: string): Promise<void> {
  // userId kosulu SART: aksi halde kullanici baskasinin anahtarini id'sini
  // tahmin ederek iptal edebilirdi.
  const sonuc = await prisma.apiToken.updateMany({
    where: { id: tokenId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (sonuc.count === 0) {
    throw new NotFoundError("API anahtarı bulunamadı");
  }
}

export interface TokenSahibi {
  id: string;
  name: string;
  email: string;
}

/**
 * Ham token'i dogrular ve sahibini doner. Gecersizse null.
 *
 * lastUsedAt guncellemesi BEKLENMEDEN yapiliyor (fire-and-forget): her API
 * istegine fazladan bir yazma gecikmesi eklemek istemiyoruz, alan zaten
 * yalnizca bilgi amacli. Yazma basarisiz olursa istek yine de calisir.
 */
export async function verifyApiToken(ham: string): Promise<TokenSahibi | null> {
  if (!ham.startsWith(TOKEN_ONEKI)) return null;

  const kayit = await prisma.apiToken.findUnique({
    where: { tokenHash: hashle(ham) },
    select: {
      id: true,
      revokedAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });

  if (!kayit || kayit.revokedAt) return null;

  void prisma.apiToken
    .update({ where: { id: kayit.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {
      // Yutuluyor: bilgi amacli bir alan icin istegi bastan basarisiz
      // saymak yanlis olurdu.
    });

  return kayit.user;
}

// Anahtarin son kullanma tarihi ve kapsami (scope) yok: dogrulanan anahtar
// sahibinin TUM yetkisini tasiyor. Bunun en tehlikeli sonucu, sizan bir
// anahtarin KENDI KALICILIGINI saglayabilmesi: anahtarla POST
// /api/me/api-tokens cagirip ikinci bir anahtar uretilirse, kullanici
// sizan anahtari iptal etse bile erisim surer. Ayni sekilde PATCH
// /api/auth/me ile profildeki aiApiKey/aiBaseUrl degistirilebilirdi.
//
// Kapsam alani semaya eklenene kadarki asgari onlem: hesap yonetimi uclari
// API anahtariyla gelen isteklere KAPALI, yalnizca gercek oturum (JWT)
// ile acik. Okuma uclari (GET) kasitli olarak disarida - listeleme sadece
// on ek donduruyor ve MCP tarafinin mevcut davranisini bozmuyor.
const HESAP_YONETIMI_UCLARI: ReadonlyArray<{ yol: RegExp; metotlar: readonly string[] }> = [
  // Anahtar uretme/iptal: anahtarin kendini cogaltmasini ve baska
  // anahtarlari iptal etmesini engeller.
  { yol: /^\/api\/me\/api-tokens(\/|$)/, metotlar: ["POST", "PUT", "PATCH", "DELETE"] },
  // Profil guncelleme: hassas alanlar (aiApiKey, aiBaseUrl) burada.
  { yol: /^\/api\/auth\/me\/?$/, metotlar: ["PATCH", "PUT"] },
];

/** Verilen yol+metot yalnizca JWT oturumuyla kullanilabilen bir hesap yonetimi ucu mu? */
export function hesapYonetimiUcuMu(pathname: string, method: string): boolean {
  const buyukMetot = method.toUpperCase();
  return HESAP_YONETIMI_UCLARI.some(
    (kural) => kural.yol.test(pathname) && kural.metotlar.includes(buyukMetot),
  );
}
