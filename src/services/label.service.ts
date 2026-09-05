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
  const { projectId } = await checkCardAccess(cardId, userId);

  // Etiketi kartın projesiyle sınırlayarak arıyoruz: yalnızca varlığına bakmak,
  // başka bir projenin (hatta başka organizasyonun) etiketini bu karta iliştirip
  // adını ve rengini o panodaki herkese sızdırmaya izin veriyordu.
  const label = await prisma.label.findFirst({ where: { id: labelId, projectId } });
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

  // Otomatik "öksüz etiket" temizliği kaldırıldı: Label proje seviyesinde
  // bilinçli oluşturulan bir katalog kaydı. Kullanımının sıfıra düşmesi
  // tanımın silinmesi anlamına gelmez - siliniyordu ve seçim listesinden
  // kaybolup kayıtlı görünüm/otomasyon kurallarındaki labelId'leri kırıyordu.
  // Etiket yalnızca açık deleteLabel çağrısıyla silinir.
}