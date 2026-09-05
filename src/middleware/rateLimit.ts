import { NextRequest } from "next/server";
import { errorResponse } from "@/utils/api-response";
import { verifyToken } from "@/utils/jwt";

// 30 saniyelik pencere kaba kuvvete karsi pratikte hicbir sey yapmiyordu:
// 5 deneme / 30 sn = tek IP'den saatte 600, gunde ~14.400 parola denemesi.
// Pencereyi 15 dk'ya cekmek ayni deneme butcesini 30 kat pahali hale getirir.
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 dakika
const MAX_ATTEMPTS = 10; // IP basina, pencere boyunca

// IP bazli sayac tek basina yetmiyor: saldirgan IP havuzu/proxy kullaninca
// hedef hesaba yapilan toplam deneme sinirsiz kaliyordu. Hedef hesabi ayri
// bir kovada sayiyoruz ki dagitik denemeler de tek yerde biriksin.
const ACCOUNT_MAX_ATTEMPTS = 5; // normalize edilmis e-posta basina

// AI kovasi kendi penceresini kullanir; asagidaki AI_LIMITS degerleri
// 15 dk varsayimiyla secilmisti ama koda 30 sn giriliyordu (30x zayif limit).
const AI_WINDOW_MS = 15 * 60 * 1000; // 15 dakika

const CLEANUP_INTERVAL_MS = 60 * 1000;

// XFF'te istemci IP'sinin nerede oldugu, uygulamanin onunde kac GUVENILIR
// vekil oldugundan baska bir seyle bilinemez. Sabit "son eleman" secimi iki
// yonden de yanlisti: tek vekil varken istemci basligi tamamen kontrol
// edebiliyordu (sinir tamamen baypas), CDN + platform LB gibi iki katmanli
// zincirde ise son eleman kenar sunucunun SABIT IP'si oluyor ve tum
// kullanicilar tek kovaya dusuyordu (kaba kuvvet korumasi self-DoS'a doner).
// Hop sayisi kadar sagdan sayarak dogru elemani seciyoruz.
// Render'da tek LB var, bu yuzden varsayilan 1; onune Cloudflare/CDN
// konursa TRUSTED_PROXY_HOPS=2 verilmeli.
const TRUSTED_PROXY_HOPS = Math.max(1, parseInt(process.env.TRUSTED_PROXY_HOPS || "1", 10) || 1);

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
}, CLEANUP_INTERVAL_MS).unref();

function getClientIp(request: NextRequest): string {
  // server.ts her istekte gelen degeri EZEREK yaziyor, bu yuzden sahtelenemez;
  // baslik guvenilmez oldugunda dusulecek tek saglam dayanak bu.
  const socketAddress = request.headers.get("x-socket-remote-address");

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // XFF, proxy zinciri boyunca her vekilin ekledigi IP listesidir; sagdaki
    // elemanlari bize en yakin vekiller yazar, soldakiler istemcinin kendi
    // kontrolundedir (sahtelenebilir). Guvenilir vekil sayisi kadar sagdan
    // sayarak istemci adresini seciyoruz.
    const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
    const index = parts.length - TRUSTED_PROXY_HOPS;
    if (index >= 0 && parts[index]) return parts[index];
    // Beklenen hop sayisi kadar eleman yok: baslik ya elle uydurulmus ya da
    // dagitim yapilandirmasi degismis. Uydurulmus degeri kova anahtari yapip
    // siniri baypas ettirmektense soket adresine dusuyoruz.
  }

  // Sabit "unknown" kovasi tek basina bir hizmet disi birakma yoluydu:
  // basliklarin hic ulasmadigi bir kurulumda TUM kullanicilar ayni kovayi
  // paylasip birbirini 429'a sokuyordu. Once soket adresini deniyoruz.
  // ?? degil ||: soket adresi okunamadiginda server.ts bos dize yaziyor,
  // bos dizeyi gecerli bir kova anahtari saymamak gerekiyor.
  return socketAddress || request.headers.get("x-real-ip") || "unknown";
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
    AUTH_WINDOW_MS,
    MAX_ATTEMPTS,
    (dk) => `Çok fazla deneme yaptınız. ${dk > 0 ? `${dk} dakika sonra` : 'Biraz sonra'} tekrar deneyin.`,
  );
}

function accountBucketKey(key: string, email: string) {
  // Buyuk/kucuk harf ve bosluk oyunlariyla ayni hesap icin farkli kova
  // acilmasin diye normalize ediyoruz.
  return `${key}:account:${email.trim().toLowerCase()}`;
}

// Hedef hesap kilidi. Sayaci BASARISIZ denemeler besler (recordAccountFailure);
// basarili girisler de sayilsaydi cok cihazdan giren mesru kullanici kendi
// kendini kilitlerdi. Bu yuzden burada sadece bakiyoruz, artirmiyoruz.
export function checkAccountRateLimit(key: string, email: string) {
  const now = Date.now();
  const bucket = attempts.get(accountBucketKey(key, email));

  if (!bucket || now > bucket.resetAt) return null;
  if (bucket.count < ACCOUNT_MAX_ATTEMPTS) return null;

  const retryMinutes = Math.ceil((bucket.resetAt - now) / 60000);
  return errorResponse(
    `Bu hesap için çok fazla başarısız giriş denemesi yapıldı. ${retryMinutes > 0 ? `${retryMinutes} dakika sonra` : "Biraz sonra"} tekrar deneyin.`,
    429,
    "RATE_LIMITED",
  );
}

// Basarisiz denemeyi hesap kovasina isler. Pencere ilk basarisiz denemede
// baslar; pencere boyunca ACCOUNT_MAX_ATTEMPTS asilirsa hesap gecici kilitlenir.
export function recordAccountFailure(key: string, email: string) {
  const now = Date.now();
  const bucketKey = accountBucketKey(key, email);
  const bucket = attempts.get(bucketKey);

  if (!bucket || now > bucket.resetAt) {
    attempts.set(bucketKey, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return;
  }

  bucket.count += 1;
}

// Basarili girisin ardindan hesap kovasini sifirla ki mesru kullanici
// birkac yanlis denemeden sonra dogru parolayi girince cezali kalmasin.
export function clearAccountFailures(key: string, email: string) {
  attempts.delete(accountBucketKey(key, email));
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
// ---------------------------------------------------------------------------
// GENEL TABAN LIMIT
// ---------------------------------------------------------------------------
// Yukaridaki iki kova yalnizca auth ve AI uclarini koruyordu; geri kalan ~100
// uc (kart, yorum, davet, dosya yukleme, import, organizasyon, API token)
// tamamen limitsizdi. Bu limit proxy.ts'ten TUM /api/* uzerinde calisir.
//
// Okuma ve yazma ayri kovalarda: pano surekli okunur (socket kopunca yeniden
// cekme, sekme degistirme), o yuzden okuma bolluk ister. Yazma ise hem
// veritabanina hem de e-posta/depolama gibi disa donuk kaynaklara dokundugu
// icin daha dar.
const GLOBAL_WINDOW_MS = 15 * 60 * 1000; // 15 dakika
const GLOBAL_READ_MAX = 300;
const GLOBAL_WRITE_MAX = 100;

const READ_METHODS = new Set(["GET", "HEAD"]);

// Kova anahtari: gecerli JWT varsa KULLANICI, yoksa IP.
//
// Token'i dogrulamadan icindeki userId'yi okumak limiti tamamen baypas
// ettirirdi - saldirgan her istekte rastgele bir userId ile token uydurup
// her seferinde bos bir kova acardi. Bu yuzden imza dogrulaniyor; dogrulama
// basarisiz olan her durumda (sahte imza, suresi dolmus token, MCP'nin
// "qtr_" onekli API tokeni) IP kovasina duruluyor.
//
// Burada bilerek VERITABANINA GIDILMIYOR: proxy her istekte calisiyor,
// API token dogrulamasi icin DB'ye gitmek butun uclara gecikme eklerdi.
// MCP istemcileri IP bazli limite tabi kalir, bu amac icin yeterli.
function globalBucketIdentity(request: NextRequest): string {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const payload = verifyToken(authHeader.slice(7));
      if (payload?.userId) return `user:${payload.userId}`;
    } catch {
      // Gecersiz/uyumsuz token ya da JWT_SECRET okunamadi - IP'ye dus.
      // Burada 401 DONMUYORUZ: kimlik dogrulama uclarin kendi isi, proxy'nin
      // isi yalnizca sayim. Aksi halde proxy, auth gerektirmeyen uclari da
      // kapatirdi.
    }
  }
  return `ip:${getClientIp(request)}`;
}

// auth/* ve ai/* kendi (daha dar) limitlerine sahip; onlari burada tekrar
// saymak ayni istegi iki kovaya yazmak olurdu.
const OWN_LIMIT_PATHS = /^\/api\/(auth|ai)\//;

export function hasOwnRateLimit(pathname: string): boolean {
  return OWN_LIMIT_PATHS.test(pathname);
}

export function checkGlobalRateLimit(request: NextRequest) {
  const isRead = READ_METHODS.has(request.method);
  const max = isRead ? GLOBAL_READ_MAX : GLOBAL_WRITE_MAX;

  return consume(
    `global:${isRead ? "read" : "write"}:${globalBucketIdentity(request)}`,
    GLOBAL_WINDOW_MS,
    max,
    (dk) =>
      `Çok fazla istek gönderdiniz. ${dk > 0 ? `${dk} dakika sonra` : "Biraz sonra"} tekrar deneyin.`,
  );
}

export function checkAiRateLimit(userId: string, key: keyof typeof AI_LIMITS | string) {
  // Pencere olarak AI_WINDOW_MS geciliyor: onceden buraya login'in 30 sn'lik
  // WINDOW_MS'i geliyordu, yani "15 dk'da 40 istek" sanilan limit gercekte
  // "30 sn'de 40 istek" idi ve 15 dk'lik dilimde ~1200 cagriya izin veriyordu.
  return consume(
    `${key}:user:${userId}`,
    AI_WINDOW_MS,
    AI_LIMITS[key] ?? AI_DEFAULT_LIMIT,
    (dk) => `Quantro AI kullanım sınırına ulaştınız. ${dk} dakika sonra tekrar deneyin.`,
  );
}
