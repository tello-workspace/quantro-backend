import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import { checkProjectAccess, checkColumnAccess } from "@/services/access-control.service";
import * as cardService from "@/services/card.service";
import type { CreateTemplateInput } from "@/schemas/template.schema";

// Bu dosya eskiden kendi checkProjectAdmin/checkProjectMember yardimcilarini
// tasiyordu; ikisi de yalnizca "organizationMember var mi" diye bakiyordu.
// Yani proje gorunurlugu (PRIVATE/TEAM) ve GUEST kurali sablon uclarinda hic
// uygulanmiyordu: erisemedigi projenin sablon adlari/basliklari/checklist
// maddeleri org uyesi herkese aciliyordu. Kontrol tek gercek kaynaga
// (access-control.service.checkProjectAccess) tasindi.

// Sablonlari projeyi GOREBILEN herkes gorup kullanabilir (kart olusturma
// yetkisi zaten cardService.createCard icinde ayrica kontrol ediliyor);
// sadece olusturma/silme ADMIN'e ait - yapisal/paylasilan proje konfigurasyonu.
export async function listTemplates(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);
  return prisma.cardTemplate.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}

export async function createTemplate(projectId: string, input: CreateTemplateInput, userId: string) {
  const { role } = await checkProjectAccess(projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Şablonları sadece adminler oluşturabilir");

  return prisma.cardTemplate.create({
    data: {
      projectId,
      name: input.name,
      title: input.title,
      description: input.description,
      priority: input.priority ?? "MEDIUM",
      checklistItems: input.checklistItems ?? [],
      createdById: userId,
    },
  });
}

// Mevcut bir karti sablon olarak kaydeder (Trello'da olmayan ama dogal bir
// kisayol: "bunu tekrar tekrar kuruyorum, sablona cevir").
export async function createTemplateFromCard(cardId: string, name: string, userId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: {
      column: { select: { projectId: true } },
      checklistItems: { orderBy: { position: "asc" }, select: { text: true } },
    },
  });
  if (!card) throw new NotFoundError("Kart");

  const { role } = await checkProjectAccess(card.column.projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Şablonları sadece adminler oluşturabilir");

  return prisma.cardTemplate.create({
    data: {
      projectId: card.column.projectId,
      name,
      title: card.title,
      description: card.description,
      priority: card.priority,
      checklistItems: card.checklistItems.map((c) => c.text),
      createdById: userId,
    },
  });
}

export async function deleteTemplate(templateId: string, userId: string) {
  const template = await prisma.cardTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw new NotFoundError("Şablon");

  const { role } = await checkProjectAccess(template.projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Şablonları sadece adminler silebilir");

  await prisma.cardTemplate.delete({ where: { id: templateId } });
}

// cardService.createCard yalnizca HEDEF sutunun yetkisini dogruluyor; KAYNAK
// sablonun icerigine erisim yetkisini hic sormuyordu. Sablon id'si sadece
// govdedeki columnId ile birlikte gonderildigi icin baska bir kiracinin
// sablon id'sini bilen herkes onun basligini/aciklamasini/checklist'ini kendi
// panosunda kart olarak dogurtup okuyabiliyordu (IDOR). Sablonun hedef sutunla
// AYNI projede olmasi sart kosuluyor; sutuna erisim de ayrica dogrulaniyor.
export async function createCardFromTemplate(templateId: string, columnId: string, userId: string) {
  const template = await prisma.cardTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw new NotFoundError("Şablon");

  const { projectId: hedefProjectId } = await checkColumnAccess(columnId, userId);
  // Erisilemeyen sablonun VARLIGINI bile sizdirmamak icin Forbidden degil
  // NotFound donuluyor.
  if (template.projectId !== hedefProjectId) throw new NotFoundError("Şablon");

  const card = await cardService.createCard(
    columnId,
    {
      title: template.title,
      description: template.description ?? undefined,
      priority: template.priority,
    },
    userId,
  );

  if (template.checklistItems.length > 0) {
    await prisma.checklistItem.createMany({
      data: template.checklistItems.map((text, index) => ({
        cardId: card.id,
        text,
        position: index + 1,
      })),
    });
  }

  return card;
}
