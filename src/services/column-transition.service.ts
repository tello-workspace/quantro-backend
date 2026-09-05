import { prisma } from "@/lib/prisma";

// Kolon GECIS kurallari burada duruyor cunku iki cagiran var: card.service
// (manuel/AI/toplu tasima) ve automation.service (MOVE_TO_COLUMN aksiyonu).
// card.service zaten automation.service'i import ettigi icin fonksiyon orada
// kalsaydi otomasyon tarafi dairesel import'a girecekti - bu yuzden ortak
// modul. Davranis card.service'teki haliyle bire bir ayni.
//
// Kolonun kendi kurallari (transitionMode + 4 bayrak) kapaliysa (OFF)
// hicbir sorgu atmadan hemen donuyor - serbest gecis varsayilan davranis,
// ekstra sorgu maliyeti sadece kural acikken var.
export async function checkColumnTransitionRules(
  cardId: string,
  destColumn: {
    transitionMode: "OFF" | "WARN" | "ENFORCE";
    requireAssignee: boolean;
    requireChecklistComplete: boolean;
    requireDescription: boolean;
    requireNoOpenBlockers: boolean;
  },
): Promise<string[]> {
  if (destColumn.transitionMode === "OFF") return [];

  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: {
      description: true,
      assignees: { select: { userId: true } },
      checklistItems: { select: { done: true } },
      blockedBy: { select: { blocker: { select: { column: { select: { isDone: true } } } } } },
    },
  });
  if (!card) return [];

  const ihlaller: string[] = [];

  if (destColumn.requireAssignee && card.assignees.length === 0) {
    ihlaller.push("Atanan kişi yok");
  }

  if (destColumn.requireChecklistComplete && card.checklistItems.length > 0) {
    const acik = card.checklistItems.filter((i) => !i.done).length;
    if (acik > 0) ihlaller.push(`${acik} checklist maddesi açık`);
  }

  if (destColumn.requireDescription && !card.description?.trim()) {
    ihlaller.push("Açıklama boş");
  }

  if (destColumn.requireNoOpenBlockers) {
    const acikBloklayan = card.blockedBy.filter((d) => !d.blocker.column.isDone).length;
    if (acikBloklayan > 0) ihlaller.push(`${acikBloklayan} bloklayan kart hâlâ açık`);
  }

  return ihlaller;
}
