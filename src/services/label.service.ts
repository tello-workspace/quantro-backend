import { prisma } from "@/lib/prisma";
import { NotFoundError, ConflictError } from "@/utils/errors";
import { checkProjectAccess, checkCardAccess } from "@/services/access-control.service";
import type { CreateLabelInput, UpdateLabelInput } from "@/schemas/label.schema";

// --- LABEL CRUD ---

export async function createLabel(projectId: string, input: CreateLabelInput, userId: string) {
  await checkProjectAccess(projectId, userId);

  const label = await prisma.label.create({
    data: {
      projectId,
      name: input.name,
      color: input.color,
    },
  });

  return label;
}

export async function getLabels(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  const labels = await prisma.label.findMany({
    where: { projectId },
    orderBy: { name: "asc" },
  });

  return labels;
}

export async function updateLabel(labelId: string, input: UpdateLabelInput, userId: string) {
  const label = await prisma.label.findUnique({ where: { id: labelId } });
  if (!label) throw new NotFoundError("Etiket");

  await checkProjectAccess(label.projectId, userId);

  const updated = await prisma.label.update({
    where: { id: labelId },
    data: input,
  });

  return updated;
}

export async function deleteLabel(labelId: string, userId: string) {
  const label = await prisma.label.findUnique({ where: { id: labelId } });
  if (!label) throw new NotFoundError("Etiket");

  await checkProjectAccess(label.projectId, userId);

  await prisma.label.delete({ where: { id: labelId } });
}

// --- CARD-LABEL İLİŞKİSİ ---

export async function attachLabelToCard(cardId: string, labelId: string, userId: string) {
  await checkCardAccess(cardId, userId);

  // Etiketin varlığını kontrol et
  const label = await prisma.label.findUnique({ where: { id: labelId } });
  if (!label) throw new NotFoundError("Etiket");

  // Zaten ekli mi?
  const existing = await prisma.cardLabel.findUnique({
    where: { cardId_labelId: { cardId, labelId } },
  });
  if (existing) throw new ConflictError("Bu etiket zaten karta ekli");

  const cardLabel = await prisma.cardLabel.create({
    data: { cardId, labelId },
    include: { label: true },
  });

  return cardLabel;
}

export async function removeLabelFromCard(cardId: string, labelId: string, userId: string) {
  await checkCardAccess(cardId, userId);

  const cardLabel = await prisma.cardLabel.findUnique({
    where: { cardId_labelId: { cardId, labelId } },
  });
  if (!cardLabel) throw new NotFoundError("Bu etiket karta ekli değil");

  await prisma.cardLabel.delete({
    where: { cardId_labelId: { cardId, labelId } },
  });

  // Clean up label if it is no longer used by any card
  const usageCount = await prisma.cardLabel.count({
    where: { labelId },
  });
  if (usageCount === 0) {
    await prisma.label.delete({ where: { id: labelId } }).catch((err) => {
      console.warn(`[Label Cleanup] Orphaned label silinirken hata: ${labelId}`, err.message);
    });
  }
}