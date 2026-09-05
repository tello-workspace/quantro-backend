import { prisma } from "@/lib/prisma";
import { logActivity } from "@/services/activity.service";
import { notifyWatchers } from "@/services/watcher.service";
import { notifyBlockerResolved } from "@/services/dependency.service";
import { checkColumnTransitionRules } from "@/services/column-transition.service";
import { broadcastToProject, SocketEvents } from "@/server/socket";

// SISTEM KAYNAKLI KART TASIMA.
//
// Kullanicinin surukleme hareketiyle degil, otomatik bir yolla tetiklenen
// tasimalar burada toplaniyor. Iki cagirani var:
//   1. automation.service (MOVE_TO_COLUMN aksiyonu)
//   2. github-webhook.service (PR acildi/merge edildi)
//
// Fonksiyon otomasyon icinde ozel bir blokken duruyordu; ikinci cagiran
// ortaya cikinca ortak module tasindi. Kopyalanmasi hâlinde ayni hatanin
// iki yerde ayri ayri duzeltilmesi gerekirdi - column-transition.service.ts
// ile birebir ayni gerekce.
//
// card.service.updateCard'i CAGIRMIYOR: o fonksiyon istegi yapan kullanicinin
// yetkisini dogruluyor ve kendi icinde otomasyon motorunu tetikliyor. Sistem
// yolunda ne dogrulanacak bir istek sahibi var ne de tetikleme zinciri
// istiyoruz - aksiyonlarin birbirini tekrar tetiklememesi sonsuz dongu
// riskini YAPISAL olarak kaldiran sey.

export interface SistemTasimaSonucu {
  /** Tasima gerceklesti mi. false ise sebep `atlanmaNedeni` alaninda. */
  tasindi: boolean;
  atlanmaNedeni?: "kolon-yok" | "baska-proje" | "kart-yok" | "zaten-orada" | "gecis-kurali";
  /** ENFORCE modunda tasimayi engelleyen kural ihlalleri. */
  ihlaller?: string[];
}

/**
 * Karti hedef kolona tasir ve manuel tasimanin TUM yan etkilerini uygular.
 *
 * @param aktorUserId Aktiviteye ve bildirimlere yazilacak kullanici. Gercek
 *   bir insan olmayabilir (otomasyonda kurali kuran kisi, GitHub yolunda
 *   commit sahibi ya da entegrasyonu kuran kisi) - onemli olan denetim
 *   izinin bir kimlige baglanmasi.
 * @param kaynakEtiketi Log satirlarinda gorunen cagiran adi ("automation",
 *   "github"). Hangi mekanizmanin tasidigini log'dan ayirt edebilmek icin.
 */
export async function sistemKartTasi(input: {
  cardId: string;
  hedefColumnId: string;
  projectId: string;
  aktorUserId: string;
  kaynakEtiketi: string;
}): Promise<SistemTasimaSonucu> {
  const { cardId, hedefColumnId, projectId, aktorUserId, kaynakEtiketi } = input;

  const column = await prisma.column.findUnique({ where: { id: hedefColumnId } });
  if (!column) return { tasindi: false, atlanmaNedeni: "kolon-yok" };

  // Kart baska bir projenin sutununa DUSMEMELI: manuel yol bunu
  // card.service.ts'te ValidationError ile yasakliyor. Sinira uyulmazsa kart
  // karsi kiracinin panosunda beliriyor ve kart numarasi orada cakisiyor.
  if (column.projectId !== projectId) return { tasindi: false, atlanmaNedeni: "baska-proje" };

  // title ve eski sutun adi da cekiliyor: asagidaki aktivite kaydi ile
  // izleyici bildirimi manuel yoldaki metinlerin birebir aynisini uretebilsin.
  const before = await prisma.card.findUnique({
    where: { id: cardId },
    select: { columnId: true, title: true, column: { select: { name: true } } },
  });
  if (!before) return { tasindi: false, atlanmaNedeni: "kart-yok" };

  // Kart zaten hedefte: hem gereksiz yayin/bildirim uretmemek icin hem de
  // ayni olayi iki farkli yoldan alan kurulumlarda (GitHub webhook'u +
  // VS Code eklentisi ayni push'u isleyebiliyor) ikinci tasimanin no-op
  // kalmasi icin erken cikiyoruz.
  if (before.columnId === hedefColumnId) return { tasindi: false, atlanmaNedeni: "zaten-orada" };

  // Kolon gecis kurallari otomatik yollara da uygulanmali: ENFORCE modunda
  // kullanicinin surukleyerek yapamayacagi gecisi sistemin sessizce yapmasi
  // kolon kurallarini anlamsizlastirir (bloklu kart Done'a duserdi). WARN
  // modunda tasima yapilir - uyarinin muhatabi burada bir insan degil.
  const ihlaller = await checkColumnTransitionRules(cardId, column);
  if (ihlaller.length > 0 && column.transitionMode === "ENFORCE") {
    console.warn(
      `[${kaynakEtiketi}] "${column.name}" sutununun gecis kurallari nedeniyle tasima uygulanmadi: ${ihlaller.join(", ")}`,
    );
    return { tasindi: false, atlanmaNedeni: "gecis-kurali", ihlaller };
  }

  // Hedef sutunda position yeniden hesaplanmali - eski sutundaki deger oldugu
  // gibi kalirsa kart hedefte mevcut bir kartla ayni position'a dusuyor ve
  // siralama kararsiz hale geliyor (manuel yol da ayni duzeltmeyi yapiyor).
  const sonKart = await prisma.card.findFirst({
    where: { columnId: hedefColumnId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const updated = await prisma.card.update({
    where: { id: cardId },
    data: {
      columnId: hedefColumnId,
      position: (sonKart?.position ?? 0) + 1,
      lastActivityAt: new Date(),
    },
  });

  // Manuel tasima ile ayni event: bunu yayinlamazsak acik panolar kart yeni
  // sutuna gecene kadar hicbir sey gormez.
  broadcastToProject(projectId, SocketEvents.CARD_MOVED, {
    cardId: updated.id,
    fromColumnId: before.columnId,
    toColumnId: updated.columnId,
    position: updated.position,
    projectId,
  });

  // Manuel tasimanin uc yan etkisi burada da calismali; yoksa kartin Done'a
  // nasil geldigine dair denetim izi kopuyor, karti izleyenlere hicbir
  // bildirim gitmiyor ve hedef sutun isDone olsa bile bu karti bekleyen
  // bagimli kartlarin sahipleri blokajin kalktigini ogrenemiyor.
  await logActivity({
    projectId,
    userId: aktorUserId,
    type: "CARD_MOVED",
    cardId: updated.id,
    data: { from: before.column.name, to: column.name },
  });

  await notifyWatchers(
    updated.id,
    aktorUserId,
    `"${updated.title}" kartı "${before.column.name}" sütunundan "${column.name}" sütununa taşındı`,
  );

  if (column.isDone) {
    await notifyBlockerResolved(updated.id, updated.title);
    await logActivity({
      projectId,
      userId: aktorUserId,
      type: "CARD_COMPLETED",
      cardId: updated.id,
    });
  }

  return { tasindi: true };
}
