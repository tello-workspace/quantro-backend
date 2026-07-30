import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import * as cardService from "@/services/card.service";
import type { CreateTemplateInput } from "@/schemas/template.schema";

async function checkProjectAdmin(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  if (!project) throw new NotFoundError("Proje");

  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: project.organizationId, userId } },
  });
  if (!member) throw new ForbiddenError("Bu projeye erişim yetkiniz yok");
  return member.role;
}

async function checkProjectMember(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  if (!project) throw new NotFoundError("Proje");

  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: project.organizationId, userId } },
  });
  if (!member) throw new ForbiddenError("Bu projeye erişim yetkiniz yok");
}

// Sablonlari HERKES gorup kullanabilir (kart olusturma yetkisi zaten
// cardService.createCard icinde ayrica kontrol ediliyor); sadece
// olusturma/silme ADMIN'e ait - yapisal/paylasilan proje konfigurasyonu.
export async function listTemplates(projectId: string, userId: string) {
  await checkProjectMember(projectId, userId);
  return prisma.cardTemplate.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}

export async function createTemplate(projectId: string, input: CreateTemplateInput, userId: string) {
  const role = await checkProjectAdmin(projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Şablonları sadece adminler oluşturabilir");

  return prisma.cardTemplate.create({
    data: {
      projectId,
      name: input.name,
      title: input.title,
      description: input.description,
      priority: input.priority ?? "MEDIUM",
      storyPoints: input.storyPoints,
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

  const role = await checkProjectAdmin(card.column.projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Şablonları sadece adminler oluşturabilir");

  return prisma.cardTemplate.create({
    data: {
      projectId: card.column.projectId,
      name,
      title: card.title,
      description: card.description,
      priority: card.priority,
      storyPoints: card.storyPoints,
      checklistItems: card.checklistItems.map((c) => c.text),
      createdById: userId,
    },
  });
}

export async function deleteTemplate(templateId: string, userId: string) {
  const template = await prisma.cardTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw new NotFoundError("Şablon");

  const role = await checkProjectAdmin(template.projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Şablonları sadece adminler silebilir");

  await prisma.cardTemplate.delete({ where: { id: templateId } });
}

// Yetki kontrolu burada TEKRARLANMIYOR - cardService.createCard zaten
// ADMIN sarti uyguluyor, sablon kullanmak "normal" kart olusturmaktan
// farkli bir yetki seviyesi degil.
export async function createCardFromTemplate(templateId: string, columnId: string, userId: string) {
  const template = await prisma.cardTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw new NotFoundError("Şablon");

  const card = await cardService.createCard(
    columnId,
    {
      title: template.title,
      description: template.description ?? undefined,
      priority: template.priority,
      storyPoints: template.storyPoints,
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
