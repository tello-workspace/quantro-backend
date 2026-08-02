import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ValidationError } from "@/utils/errors";
import * as notificationService from "@/services/notification.service";
import { notifyBlockerResolved } from "@/services/dependency.service";
import { logActivity } from "@/services/activity.service";
import * as automationService from "@/services/automation.service";
import { broadcastToProject, SocketEvents } from "@/server/socket";
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
    select: { name: true, projectId: true, project: { select: { organizationId: true } } },
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

  return { role: member.role, projectId: column.projectId, columnName: column.name };
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

// parentCardId ayni projedeki bir karta mi isaret ediyor ve dongu olusturmuyor mu?
// (kartin kendi alt-gorevini kendine ebeveyn secmesi gibi bir A->B->A durumu)
async function validateParentCard(projectId: string, cardId: string | undefined, parentCardId: string) {
  const cycleError = () => new ValidationError("Bir kart kendi alt görevinin altına bağlanamaz");

  if (cardId && parentCardId === cardId) {
    throw cycleError();
  }

  const parent = await prisma.card.findUnique({
    where: { id: parentCardId },
    select: { parentCardId: true, column: { select: { projectId: true } } },
  });
  if (!parent || parent.column.projectId !== projectId) {
    throw new NotFoundError("Üst kart");
  }

  if (!cardId) return;

  // parentCardId'den yukari dogru zincir takip edilir - eger bu zincirde
  // cardId'ye rastlanirsa, yeni ebeveynlik bir dongu olustururdu.
  let current = parent.parentCardId;
  const visited = new Set<string>([parentCardId]);
  while (current) {
    if (current === cardId) throw cycleError();
    if (visited.has(current)) break; // guvenlik: sonsuz donguye girme
    visited.add(current);
    const next = await prisma.card.findUnique({ where: { id: current }, select: { parentCardId: true } });
    current = next?.parentCardId ?? null;
  }
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

  if (input.sprintId) {
    const sprint = await prisma.sprint.findUnique({ where: { id: input.sprintId }, select: { projectId: true } });
    if (!sprint || sprint.projectId !== projectId) throw new NotFoundError("Sprint");
  }
  if (input.parentCardId) {
    await validateParentCard(projectId, undefined, input.parentCardId);
  }

  const position = input.position ?? (await getNextPosition(columnId));

  const card = await prisma.card.create({
    data: {
      columnId,
      title: input.title,
      description: input.description,
      creatorId: userId,
      priority: (input.priority as Priority) ?? "MEDIUM",
      storyPoints: input.storyPoints,
      dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
      startDate: input.startDate ? new Date(input.startDate) : undefined,
      position,
      lastActivityAt: new Date(),
      sprintId: input.sprintId ?? undefined,
      parentCardId: input.parentCardId ?? undefined,
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
    startDate: card.startDate?.toISOString() ?? null,
    position: card.position,
    sprintId: card.sprintId,
    parentCardId: card.parentCardId,
  });

  await logActivity({ projectId, userId, type: "CARD_CREATED", cardId: card.id });

  await automationService.runRulesForTrigger({
    projectId,
    trigger: "CARD_CREATED",
    cardId: card.id,
    columnId,
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
      sprint: { select: { id: true, name: true, status: true } },
      parent: { select: { id: true, title: true } },
      subtasks: {
        select: { id: true, title: true, column: { select: { isDone: true } } },
        orderBy: { createdAt: "asc" },
      },
      customFieldValues: {
        include: { field: { select: { id: true, name: true, type: true, options: true } } },
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

  const { role, projectId, columnName: oldColumnName } = await checkColumnAccess(card.columnId, userId);

  // Yetki modeli: yapisal degisiklikler ADMIN'e ait. Uye kart TASIYABILIR
  // (kanban akisi bozulmasin), ama icerik alanlarini ve atamayi dogrudan
  // degistiremez; bunun icin degisiklik talebi acar (change-request.service).
  if (input.assigneeIds !== undefined && role !== "ADMIN") {
    throw new ForbiddenError("Sadece adminler görev ataması yapabilir");
  }

  const icerikAlanlariDegisiyor =
    input.title !== undefined ||
    input.description !== undefined ||
    input.priority !== undefined ||
    input.storyPoints !== undefined ||
    input.dueDate !== undefined ||
    input.startDate !== undefined ||
    input.sprintId !== undefined ||
    input.parentCardId !== undefined;

  if (icerikAlanlariDegisiyor && role !== "ADMIN") {
    throw new ForbiddenError(
      "Kart içeriğini sadece adminler düzenleyebilir. Değişiklik talebi gönderebilirsiniz.",
    );
  }

  if (input.sprintId) {
    const sprint = await prisma.sprint.findUnique({ where: { id: input.sprintId }, select: { projectId: true } });
    if (!sprint || sprint.projectId !== projectId) throw new NotFoundError("Sprint");
  }
  if (input.parentCardId) {
    await validateParentCard(projectId, cardId, input.parentCardId);
  }

  // Kolon değişikliği varsa hedef kolonun da erişilebilir olduğunu kontrol et
  const isColumnChange = input.columnId && input.columnId !== card.columnId;
  let newColumnName: string | undefined;
  if (isColumnChange && input.columnId) {
    const destAccess = await checkColumnAccess(input.columnId, userId);
    newColumnName = destAccess.columnName;
  }

  const hasFieldEdits =
    input.title !== undefined ||
    input.description !== undefined ||
    input.priority !== undefined ||
    input.dueDate !== undefined ||
    input.startDate !== undefined;

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
  if (input.storyPoints !== undefined) updateData.storyPoints = input.storyPoints;
  if (input.dueDate !== undefined) updateData.dueDate = input.dueDate ? new Date(input.dueDate) : null;
  if (input.startDate !== undefined) updateData.startDate = input.startDate ? new Date(input.startDate) : null;
  if (input.sprintId !== undefined) updateData.sprintId = input.sprintId;
  if (input.parentCardId !== undefined) updateData.parentCardId = input.parentCardId;
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

  let updated = await prisma.card.update({
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

    await logActivity({
      projectId,
      userId,
      type: "CARD_MOVED",
      cardId: updated.id,
      data: { from: oldColumnName, to: newColumnName },
    });

    // Kart Done sütununa taşındıysa, onu bekleyen kartların sahiplerine haber ver
    const newColumn = await prisma.column.findUnique({
      where: { id: updated.columnId },
      select: { isDone: true },
    });
    if (newColumn?.isDone) {
      await notifyBlockerResolved(updated.id, updated.title);
      await logActivity({ projectId, userId, type: "CARD_COMPLETED", cardId: updated.id });
    }

    await automationService.runRulesForTrigger({
      projectId,
      trigger: "CARD_MOVED_TO_COLUMN",
      cardId: updated.id,
      columnId: updated.columnId,
    });

    // Otomasyon kurallari ayni karti (ornegin ASSIGN_USER ile assignees'i)
    // degistirmis olabilir ve kendi dogru card:updated yayinini az once yapti.
    // Asagidaki kosulsuz son yayin ve HTTP yaniti hala yukaridaki ESKI
    // `updated` snapshot'ini kullansaydi, otomasyonun yayinladigi guncel veriyi
    // hemen ardindan eski veriyle ezip herkesin panosunda (ozellikle bu istegi
    // atan kullanicinin kendi sekmesinde, HTTP yaniti da bu eski veriyi
    // tasidigi icin) sayfa yenilenene kadar gorunmez hale getirirdi.
    updated = await prisma.card.findUniqueOrThrow({
      where: { id: cardId },
      include: assigneeInclude,
    });
  }

  if (newlyAssignedIds.length > 0) {
    broadcastToProject(projectId, SocketEvents.CARD_ASSIGNED, {
      cardId: updated.id,
      cardTitle: updated.title,
      assignees: updated.assignees.map((a) => ({ id: a.user.id, name: a.user.name })),
    });

    await logActivity({
      projectId,
      userId,
      type: "CARD_ASSIGNED",
      cardId: updated.id,
      data: { assignedTo: updated.assignees.map((a) => a.user.name) },
    });
  }

  if (hasFieldEdits) {
    await logActivity({ projectId, userId, type: "CARD_UPDATED", cardId: updated.id });
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
    startDate: updated.startDate?.toISOString() ?? null,
    position: updated.position,
    sprintId: updated.sprintId,
    parentCardId: updated.parentCardId,
  });

  return updated;
}

export async function deleteCard(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({ 
    where: { id: cardId },
    include: { labels: true }
  });
  if (!card) throw new NotFoundError("Kart");

  const { role, projectId } = await checkColumnAccess(card.columnId, userId);
  if (role !== "ADMIN") {
    throw new ForbiddenError(
      "Kartı sadece adminler silebilir. Silme talebi gönderebilirsiniz.",
    );
  }

  const labelIds = card.labels.map((cl) => cl.labelId);

  await prisma.card.delete({ where: { id: cardId } });

  // Clean up orphaned labels
  if (labelIds.length > 0) {
    for (const labelId of labelIds) {
      const usageCount = await prisma.cardLabel.count({
        where: { labelId },
      });
      if (usageCount === 0) {
        await prisma.label.delete({ where: { id: labelId } }).catch((err) => {
          console.warn(`[Label Cleanup] Orphaned label silinirken hata: ${labelId}`, err.message);
        });
      }
    }
  }

  broadcastToProject(projectId, SocketEvents.CARD_DELETED, { cardId, projectId });
}
