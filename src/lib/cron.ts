import cron from "node-cron";
import { runNightlyScan } from "@/services/scan.service";

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

  console.log("[cron] Gece taraması zamanlandı (her gün 03:00)");
}
