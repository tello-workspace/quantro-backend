import crypto from "node:crypto";

// GitHub webhook imza dogrulamasi (X-Hub-Signature-256).
//
// GitHub, gonderdigi HAM govdenin HMAC-SHA256'sini depo ayarlarindaki secret
// ile hesaplayip "sha256=<hex>" biciminde basliga koyuyor. Dogrulama bu
// endpoint'in TEK kimlik dogrulama mekanizmasi: adres tahmin edilebilir,
// govde saldirganin kontrolunde olabilir, guvenilen tek sey imza.
//
// GOVDE HAM HALIYLE kullanilmak zorunda. JSON.parse edip yeniden
// serilestirmek anahtar sirasini, bosluklari ve unicode kacislarini
// degistirir; imza tutmaz. Cagiran taraf once request.text() ile okuyup
// burada dogrular, ANCAK ONDAN SONRA parse eder.

const IMZA_ONEKI = "sha256=";

export function githubImzasiDogrula(
  hamGovde: string,
  imzaBasligi: string | null,
  secret: string,
): boolean {
  if (!imzaBasligi || !imzaBasligi.startsWith(IMZA_ONEKI)) return false;

  const beklenen = IMZA_ONEKI + crypto.createHmac("sha256", secret).update(hamGovde, "utf8").digest("hex");

  // timingSafeEqual esit uzunluk sart kosuyor ve farkli uzunlukta ATIYOR.
  // Uzunluk zaten gizli bir bilgi degil (hex SHA-256 her zaman ayni boyda),
  // bu yuzden once uzunluga bakip erken donmek bir sey sizdirmiyor - eksik
  // kontrol ise fonksiyonun kendisini patlatirdi.
  const gelen = Buffer.from(imzaBasligi, "utf8");
  const hesaplanan = Buffer.from(beklenen, "utf8");
  if (gelen.length !== hesaplanan.length) return false;

  // Duz === karsilastirmasi ilk farkli karakterde donerdi; saldirgan cevap
  // suresini olcerek imzayi karakter karakter bulabilirdi.
  return crypto.timingSafeEqual(gelen, hesaplanan);
}

/** Depo webhook'u kurulurken kullaniciya verilecek secret. */
export function webhookSecretUret(): string {
  return crypto.randomBytes(32).toString("hex");
}
