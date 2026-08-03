import { prisma } from "@/lib/prisma";
import { ForbiddenError, NotFoundError } from "@/utils/errors";
import * as cardService from "@/services/card.service";
import * as labelService from "@/services/label.service";

// Toplu islem, yetki kurallarini YENIDEN YAZMAK yerine tek kartlik servisleri
// donguyle cagirir. Boylece izin kontrolu, socket yayini, aktivite kaydi ve
// dogrulama tek kartlik islemle birebir ayni kalir - burada ikinci bir yetki
// modeli olusturmak, ileride biri card.service'i degistirdiginde sessizce
// ayrisacak bir kopya yaratirdi.
//
// Islem atomik degil: her kart bagimsiz basarili/basarisiz olabilir ve sonuc
// bunu acikca raporlar. Tek kartlik akis da zaten kart basina yayin yaptigi
// icin bu mevcut modelle tutarli.

export type BulkAction = "move" | "assign" | "label" | "archive" | "delete";

export interface BulkInput {
  cardIds: string[];
  action: BulkAction;
  columnId?: string;
  assigneeIds?: string[];
  labelId?: string;
}

export interface BulkResult {
  basarili: string[];
  basarisiz: { cardId: string; sebep: string }[];
}

// Kartlarin hepsi gercekten bu projeye mi ait? Istemciden gelen id listesine
// guvenmiyoruz: baska bir projenin karti listeye sizerse, tek kartlik servis
// yetkiyi yine reddederdi ama hata mesaji kafa karistirici olurdu.
async function projeKartlariniDogrula(projectId: string, cardIds: string[]) {
  const kartlar = await prisma.card.findMany({
    where: { id: { in: cardIds }, column: { projectId } },
    select: { id: true },
  });

  const gecerli = new Set(kartlar.map((k) => k.id));
  return {
    gecerli: cardIds.filter((id) => gecerli.has(id)),
    gecersiz: cardIds.filter((id) => !gecerli.has(id)),
  };
}

export async function bulkCardAction(
  projectId: string,
  input: BulkInput,
  userId: string,
): Promise<BulkResult> {
  const { gecerli, gecersiz } = await projeKartlariniDogrula(projectId, input.cardIds);

  const sonuc: BulkResult = {
    basarili: [],
    basarisiz: gecersiz.map((cardId) => ({ cardId, sebep: "Kart bu projede bulunamadı" })),
  };

  if (gecerli.length === 0) return sonuc;

  // Hedef kolon dogrulamasi bir kez yapiliyor - her kart icin tekrarlamak
  // gereksiz sorgu olurdu.
  if (input.action === "move") {
    if (!input.columnId) throw new NotFoundError("Hedef sütun");
    const kolon = await prisma.column.findFirst({
      where: { id: input.columnId, projectId },
      select: { id: true },
    });
    if (!kolon) throw new NotFoundError("Hedef sütun");
  }

  if (input.action === "label" && !input.labelId) {
    throw new NotFoundError("Etiket");
  }

  // Tasima sirasinda pozisyon hesabi kartlarin birbirini etkilemesine yol
  // actigi icin sirali ilerliyoruz. Diger islemlerde de sirali kaliyoruz:
  // kart sayisi tipik olarak onlarla ifade ediliyor ve paralellik burada
  // olcolebilir bir kazanc saglamiyor, buna karsilik hata sirasini bozuyor.
  for (const cardId of gecerli) {
    try {
      switch (input.action) {
        case "move":
          await cardService.updateCard(cardId, { columnId: input.columnId }, userId);
          break;

        case "assign":
          await cardService.updateCard(cardId, { assigneeIds: input.assigneeIds ?? [] }, userId);
          break;

        case "label":
          await labelService.attachLabelToCard(cardId, input.labelId!, userId);
          break;

        case "archive":
          await cardService.archiveCard(cardId, userId);
          break;

        case "delete":
          await cardService.deleteCard(cardId, userId);
          break;
      }
      sonuc.basarili.push(cardId);
    } catch (error) {
      // Etiket zaten ekliyse bu bir hata degil, istenen son durum zaten
      // saglanmis demektir - toplu islemde kullaniciya hata gostermek
      // yaniltici olurdu.
      if (input.action === "label" && (error as { statusCode?: number })?.statusCode === 409) {
        sonuc.basarili.push(cardId);
        continue;
      }

      const mesaj =
        error instanceof ForbiddenError || error instanceof NotFoundError
          ? error.message
          : "İşlem uygulanamadı";
      sonuc.basarisiz.push({ cardId, sebep: mesaj });
    }
  }

  return sonuc;
}
