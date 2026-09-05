import { errorResponse } from "@/utils/api-response";

// Gece taramasi (/api/scan) ve gunluk ozet (/api/digest) uclari TUM
// organizasyonlarin verisini isler: tek bir tetikleme platformdaki her
// projede zamanlanmis otomasyonlari calistirir ve her kullaniciya e-posta
// gonderebilir. Bu uclarda hicbir sayac yoktu; herhangi bir org'un ADMIN'i
// istegi dongude atarak yabanci organizasyonlarin panolarinda kart/bildirim
// uretebiliyor ve paylasilan DB'ye agir yuk bindirebiliyordu. Sinir yalnizca
// MANUEL (kullanici kimlikli) tetiklemeye uygulanir - x-cron-secret ile gelen
// zamanlanmis is bu fonksiyona hic ugramaz.
const PENCERE_MS = 60 * 60 * 1000; // 1 saat
const MAKS_TETIKLEME = 1; // kullanici basina saatte 1 manuel calistirma

interface Kova {
  sayac: number;
  sifirlanmaAni: number;
}

// Anahtar sayisi (uc x manuel tetikleyen kullanici) kucuk kaldigi ve suresi
// dolan kova yerine yenisi yazildigi icin ayrica temizlik dongusu gerekmiyor.
const kovalar = new Map<string, Kova>();

// Sinir asilmissa hazir 429 cevabi, asilmamissa null doner (route'lardaki
// authError deseniyle ayni sekilde kullanilir).
export function checkCronTriggerLimit(key: string, userId: string) {
  const simdi = Date.now();
  const kovaAnahtari = `${key}:user:${userId}`;
  const kova = kovalar.get(kovaAnahtari);

  if (!kova || simdi > kova.sifirlanmaAni) {
    kovalar.set(kovaAnahtari, { sayac: 1, sifirlanmaAni: simdi + PENCERE_MS });
    return null;
  }

  kova.sayac += 1;

  if (kova.sayac > MAKS_TETIKLEME) {
    const kalanDakika = Math.max(1, Math.ceil((kova.sifirlanmaAni - simdi) / 60000));
    return errorResponse(
      `Bu işlem çok sık tetiklendi. ${kalanDakika} dakika sonra tekrar deneyin.`,
      429,
      "RATE_LIMITED",
    );
  }

  return null;
}
