import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/utils/errors";
import type { Prisma } from "@prisma/client";

/**
 * İnsan-okunur kart anahtarı: "QNT-42".
 *
 * Neden var: cuid ("cmseoy21m008xlx2lidnwavf2") kimse tarafından telaffuz
 * edilemiyor, commit mesajına yazılamıyor, toplantıda söylenemiyordu. Karta
 * referans vermenin tek yolu başlığı kopyalamaktı.
 *
 * Anahtar = Project.key + "-" + Card.number. İkisi de kalıcı: numara geri
 * kullanılmıyor, kart silinse bile o numara bir daha verilmiyor. Anahtarın
 * değeri kalıcı bir referans olmasında.
 */

// 2-5 karakter, harfle başlar, harf/rakam devam eder. Jira ile aynı sınır.
export const PROJECT_KEY_REGEX = /^[A-Z][A-Z0-9]{1,4}$/;

// "QNT-42" / "qnt-42" - kullanıcı küçük harfle yazabilmeli.
const CARD_KEY_REGEX = /^([A-Za-z][A-Za-z0-9]{1,4})-(\d{1,9})$/;

export function formatCardKey(projectKey: string, number: number): string {
  return `${projectKey}-${number}`;
}

/** "QNT-42" -> { projectKey: "QNT", number: 42 }. Biçim tutmuyorsa null. */
export function parseCardKey(input: string): { projectKey: string; number: number } | null {
  const eslesme = CARD_KEY_REGEX.exec(input.trim());
  if (!eslesme) return null;

  const number = Number(eslesme[2]);
  if (!Number.isSafeInteger(number) || number < 1) return null;

  return { projectKey: eslesme[1].toUpperCase(), number };
}

/**
 * Proje adından anahtar önerir: çok kelimeliyse baş harfler ("Quantro
 * Backend" -> "QB"), tek kelimeliyse ilk 3 harf ("Quantro" -> "QUA").
 * Türkçe karakterler ASCII karşılığına indirgeniyor ("Ödeme" -> "ODE"),
 * yoksa harf filtresi onları düşürüp anahtarı boşaltırdı.
 */
export function suggestProjectKey(name: string): string {
  const asciiye: Record<string, string> = {
    Ç: "C", Ğ: "G", İ: "I", I: "I", Ö: "O", Ş: "S", Ü: "U",
  };
  const sadelesmis = name
    .toUpperCase()
    .replace(/[ÇĞİIÖŞÜ]/g, (harf) => asciiye[harf] ?? harf);

  const kelimeler = sadelesmis
    .split(/[^A-Z0-9]+/)
    .map((k) => k.replace(/[^A-Z]/g, ""))
    .filter(Boolean);

  if (kelimeler.length === 0) return "PRJ";

  if (kelimeler.length >= 2) {
    const basHarfler = kelimeler.map((k) => k[0]).join("").slice(0, 5);
    // Tek harf kalırsa (tek kelimelik gibi davranır) alttaki dala düşsün.
    if (basHarfler.length >= 2) return basHarfler;
  }

  return kelimeler[0].slice(0, 3).padEnd(2, "X");
}

/**
 * Organizasyon içinde boş olan ilk anahtarı bulur: "QUA" doluysa "QUA2",
 * "QUA3"... Anahtar 5 karakteri aşamayacağı için gerekirse kök kısaltılıyor.
 */
export async function findAvailableProjectKey(
  organizationId: string,
  istenen: string,
): Promise<string> {
  const kok = istenen.slice(0, 5);

  const mevcutlar = await prisma.project.findMany({
    where: { organizationId, key: { startsWith: kok.slice(0, 3) } },
    select: { key: true },
  });
  const dolu = new Set(mevcutlar.map((p) => p.key));

  if (!dolu.has(kok)) return kok;

  for (let ek = 2; ek < 1000; ek++) {
    const sonek = String(ek);
    const aday = `${kok.slice(0, 5 - sonek.length)}${sonek}`;
    if (!dolu.has(aday)) return aday;
  }

  throw new ValidationError("Bu organizasyonda uygun bir proje anahtarı üretilemedi");
}

/** Kullanıcının girdiği anahtarı normalize eder ve biçimini doğrular. */
export function normalizeProjectKey(input: string): string {
  const anahtar = input.trim().toUpperCase();
  if (!PROJECT_KEY_REGEX.test(anahtar)) {
    throw new ValidationError(
      "Proje anahtarı 2-5 karakter olmalı, harfle başlamalı ve yalnızca harf/rakam içermeli (örn. QNT)",
    );
  }
  return anahtar;
}

/**
 * Bu proje için bir sonraki kart numarasını AYIRIR.
 *
 * `increment` tek bir `UPDATE ... SET "cardCounter" = "cardCounter" + 1
 * RETURNING` sorgusuna çevriliyor; Postgres bunu satır kilidi altında
 * yürüttüğü için eşzamanlı iki kart oluşturma aynı numarayı alamaz.
 *
 * Numara kart yaratma işlemiyle AYNI transaction'da alınmalı ki kart
 * yaratma başarısız olduğunda numara da boşa harcanmasın. Transaction
 * dışında çağrılırsa (varsayılan) numara ayrılır ama kart açılmazsa o numara
 * bir daha kullanılmaz - anahtar dizisinde delik oluşur. Bu kabul edilebilir:
 * Jira da aynı şekilde davranıyor, önemli olan tekillik.
 */
export async function allocateCardNumber(
  projectId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  const proje = await client.project.update({
    where: { id: projectId },
    data: { cardCounter: { increment: 1 } },
    select: { cardCounter: true },
  });
  return proje.cardCounter;
}

/**
 * Anahtarla kart bulur. Organizasyon sınırı içinde arar: "QNT-42" bir org'da
 * tek bir kartı gösterir (Project.key org içinde benzersiz).
 */
export async function findCardByKey(organizationId: string, anahtar: string) {
  const ayrilmis = parseCardKey(anahtar);
  if (!ayrilmis) return null;

  const card = await prisma.card.findFirst({
    where: {
      number: ayrilmis.number,
      column: {
        project: {
          organizationId,
          key: ayrilmis.projectKey,
        },
      },
    },
    select: {
      id: true,
      title: true,
      description: true,
      priority: true,
      number: true,
      isArchived: true,
      column: {
        select: {
          id: true,
          name: true,
          project: { select: { id: true, name: true, key: true } },
        },
      },
    },
  });

  return card;
}
