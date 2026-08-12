import cron from "node-cron";
import { runNightlyScan } from "@/services/scan.service";
import { runDailyDigest } from "@/services/digest.service";

let started = false;

export function startCronJobs() {
  if (started) return;
  started = true;

  // Her gece 03:00'te stale kart / deadline riski / WIP asimi taramasi.
  // Bu sadece process o an ayaktaysa calisir (Render Free planda uykuya
  // dalmis olabilir) - bu yuzden .github/workflows/nightly-scan.yml ayni
  // taramayi disaridan /api/scan uzerinden de tetikliyor. runNightlyScan
  // idempotent oldugu icin (notifyOnce) ikisinin ayni gece calismasi zararsiz.
  cron.schedule("0 3 * * *", () => {
    runNightlyScan().catch((err) => console.error("[cron] tarama hatası:", err));
  });

  // Sabah 08:00'de gunluk ozet e-postasi - ayni sebeple (Render uyku modu)
  // .github/workflows/daily-digest.yml disaridan /api/digest'i de tetikliyor.
  // runDailyDigest User.lastDigestSentAt ile GUNLUK idempotent: ayni gun
  // icinde iki kez cagrilsa bile ikinci calisma her kullaniciyi "bugun
  // zaten gonderildi" diye atlar, gercek e-posta iki kez gitmez.
  cron.schedule("0 8 * * *", () => {
    runDailyDigest().catch((err) => console.error("[cron] günlük özet hatası:", err));
  });

  console.log("[cron] Gece taraması (03:00) ve günlük özet (08:00) zamanlandı");
}
