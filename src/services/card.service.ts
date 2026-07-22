import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import * as notificationService from "@/services/notification.service";
import { broadcastToProject, broadcastToCard, SocketEvents } from "@/server/socket";
import type { CreateCardInput, UpdateCardInput } from "@/schemas/card.schema";
import type { Priority } from "@prisma/client";

const assigneeInclude = {
  assignees: {
    include: { user: { select: { id: true, name: true, email: true } } },
  },
} as const;

// Kolonun projesine ve organizasyonuna erişim kontrolü
async function checkColumnAccess(columnId: string, userId: string) {
  const column = await prisma.column.findUnique({
    where: { id: columnId },
    select: { projectId: true, project: { select: { organizationId: true } } },
  });
  if (!column) throw new NotFoundError("Sütun");

  const member = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: column.project.organizationId,
        userId,
      },
    },
  });
  if (!member) throw new ForbiddenError("Bu projeye erişim yetkiniz yok");

  return { role: member.role, projectId: column.projectId };
}

// Fraksiyonel pozisyon hesapla
// Verilen kolonda en sondaki position'ı bulup +1 verir
async function getNextPosition(columnId: string): Promise<number> {
  const lastCard = await prisma.card.findFirst({
    where: { columnId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return (lastCard?.position ?? 0) + 1;
}

// Atanan kişilerin hepsinin organizasyon üyesi olduğunu doğrula
async function validateAssignees(columnId: string, assigneeIds: string[]) {
  if (assigneeIds.length === 0) return;

  const column = await prisma.column.findUnique({
    where: { id: columnId },
    select: { project: { select: { organizationId: true } } },
  });
  if (!column) throw new NotFoundError("Sütun");

  const members = await prisma.organizationMember.findMany({
    where: {
      organizationId: column.project.organizationId,
      userId: { in: assigneeIds },
    },
    select: { userId: true },
  });

  if (members.length !== assigneeIds.length) {
    throw new ForbiddenError("Atanan kişilerden biri bu organizasyonun üyesi değil");
  }
}

export async function createCard(columnId: string, input: CreateCardInput, userId: string) {
  const { role, projectId } = await checkColumnAccess(columnId, userId);
  if (role !== "ADMIN") {
    throw new ForbiddenError("Sadece adminler kart oluşturabilir");
  }

  const assigneeIds = input.assigneeIds ?? [];
  await validateAssignees(columnId, assigneeIds);

  const position = input.position ?? (await getNextPosition(columnId));

  const card = await prisma.card.create({
    data: {
      columnId,
      title: input.title,
      description: input.description,
      creatorId: userId,
      priority: (input.priority as Priority) ?? "MEDIUM",
      dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
      position,
      lastActivityAt: new Date(),
      assignees: {
        create: assigneeIds.map((id) => ({ userId: id })),
      },
    },
    include: assigneeInclude,
  });

  for (const assigneeId of assigneeIds) {
    await notificationService.createNotification({
      userId: assigneeId,
      type: "ASSIGNED",
      message: `"${card.title}" kartı size atandı`,
      cardId: card.id,
    });
  }

  broadcastToProject(projectId, SocketEvents.CARD_CREATED, {
    id: card.id,
    title: card.title,
    description: card.description,
    columnId: card.columnId,
    projectId,
    assignees: card.assignees.map((a) => ({ id: a.user.id, name: a.user.name })),
    priority: card.priority,
    dueDate: card.dueDate?.toISOString() ?? null,
    position: card.position,
  });

  return card;
}

export async function getCards(columnId: string, userId: string) {
  await checkColumnAccess(columnId, userId);

  const cards = await prisma.card.findMany({
    where: { columnId },
    orderBy: { position: "asc" },
    include: {
      ...assigneeInclude,
      _count: { select: { comments: true } },
    },
  });

  return cards;
}

export async function getCardById(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: {
      ...assigneeInclude,
      column: { select: { id: true, name: true, projectId: true } },
      comments: {
        orderBy: { createdAt: "desc" },
        include: { author: { select: { id: true, name: true, email: true } } },
      },
      labels: { include: { label: true } },
      blocking: {
        include: { blocked: { select: { id: true, title: true } } },
      },
      blockedBy: {
        include: { blocker: { select: { id: true, title: true } } },
      },
    },
  });

  if (!card) throw new NotFoundError("Kart");

  // Yetki kontrolü: kartın kolonunun projesine erişim var mı?
  await checkColumnAccess(card.columnId, userId);

  return card;
}

export async function updateCard(cardId: string, input: UpdateCardInput, userId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { assignees: { select: { userId: true } } },
  });
  if (!card) throw new NotFoundError("Kart");

  const { role, projectId } = await checkColumnAccess(card.columnId, userId);

  // Kimin kime atanacagina sadece ADMIN karar verir; kart tasima (surukleme)
  // ve diger alanlarin duzenlenmesi tum uyelere acik kalir
  if (input.assigneeIds !== undefined && role !== "ADMIN") {
    throw new ForbiddenError("Sadece adminler görev ataması yapabilir");
  }

  // Kolon değişikliği varsa hedef kolonun da erişilebilir olduğunu kontrol et
  const isColumnChange = input.columnId && input.columnId !== card.columnId;
  if (isColumnChange && input.columnId) {
    await checkColumnAccess(input.columnId, userId);
  }

  const oldAssigneeIds = new Set(card.assignees.map((a) => a.userId));
  let newlyAssignedIds: string[] = [];

  if (input.assigneeIds !== undefined) {
    const colId = input.columnId ?? card.columnId;
    await validateAssignees(colId, input.assigneeIds);
    newlyAssignedIds = input.assigneeIds.filter((id) => !oldAssigneeIds.has(id));
  }

  const updateData: Record<string, unknown> = {};
  if (input.title !== undefined) updateData.title = input.title;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.priority !== undefined) updateData.priority = input.priority as Priority;
  if (input.dueDate !== undefined) updateData.dueDate = input.dueDate ? new Date(input.dueDate) : null;
  if (input.columnId !== undefined) updateData.columnId = input.columnId;
  if (input.position !== undefined) updateData.position = input.position;
  if (input.assigneeIds !== undefined) {
    updateData.assignees = {
      deleteMany: {},
      create: input.assigneeIds.map((id) => ({ userId: id })),
    };
  }

  // Kolon değişikliği var ama position verilmemişse sona ekle
  if (isColumnChange && input.position === undefined) {
    const lastCard = await prisma.card.findFirst({
      where: { columnId: input.columnId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    updateData.position = (lastCard?.position ?? 0) + 1;
  }

  // Kartta değişiklik var → lastActivityAt güncelle
  if (Object.keys(updateData).length > 0) {
    updateData.lastActivityAt = new Date();
  }

  const updated = await prisma.card.update({
    where: { id: cardId },
    data: updateData,
    include: assigneeInclude,
  });

  // Sadece yeni eklenen atananlara bildirim gönder
  for (const assigneeId of newlyAssignedIds) {
    await notificationService.createNotification({
      userId: assigneeId,
      type: "ASSIGNED",
      message: `"${updated.title}" kartı size atandı`,
      cardId: updated.id,
    });
  }

  if (isColumnChange) {
    broadcastToProject(projectId, SocketEvents.CARD_MOVED, {
      cardId: updated.id,
      fromColumnId: card.columnId,
      toColumnId: updated.columnId,
      position: updated.position,
      projectId,
    });
  }

  if (newlyAssignedIds.length > 0) {
    broadcastToProject(projectId, SocketEvents.CARD_ASSIGNED, {
      cardId: updated.id,
      cardTitle: updated.title,
      assignees: updated.assignees.map((a) => ({ id: a.user.id, name: a.user.name })),
    });
  }

  broadcastToProject(projectId, SocketEvents.CARD_UPDATED, {
    id: updated.id,
    title: updated.title,
    description: updated.description,
    columnId: updated.columnId,
    projectId,
    assignees: updated.assignees.map((a) => ({ id: a.user.id, name: a.user.name })),
    priority: updated.priority,
    dueDate: updated.dueDate?.toISOString() ?? null,
    position: updated.position,
  });

  return updated;
}

export async function deleteCard(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card) throw new NotFoundError("Kart");

  const { projectId } = await checkColumnAccess(card.columnId, userId);

  await prisma.card.delete({ where: { id: cardId } });

  broadcastToProject(projectId, SocketEvents.CARD_DELETED, { cardId, projectId });
}
