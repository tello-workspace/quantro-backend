import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from "@/utils/errors";
import * as notificationService from "@/services/notification.service";
import { logActivity } from "@/services/activity.service";
import { broadcastToProject, SocketEvents } from "@/server/socket";

async function checkCardAccess(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: {
      columnId: true,
      column: { select: { projectId: true, project: { select: { organizationId: true } } } },
    },
  });
  if (!card) throw new NotFoundError("Kart");

  const member = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: card.column.project.organizationId,
        userId,
      },
    },
  });
  if (!member) throw new ForbiddenError("Bu karta erişim yetkiniz yok");

  return { projectId: card.column.projectId };
}

// blockerId'den blockedId'ye yeni bir "blocker -> blocked" kenari eklersek
// dongu olusur mu? blockedId'den baslayip mevcut "blocking" kenarlarini takip
// ederek blockerId'ye ulasilabiliyorsa, yeni kenar bir dongu kapatir.
async function wouldCreateCycle(blockerId: string, blockedId: string): Promise<boolean> {
  if (blockerId === blockedId) return true;

  const visited = new Set<string>([blockedId]);
  let queue = [blockedId];

  while (queue.length > 0) {
    if (queue.includes(blockerId)) return true;

    const deps = await prisma.cardDependency.findMany({
      where: { blockerId: { in: queue } },
      select: { blockedId: true },
    });

    const next: string[] = [];
    for (const dep of deps) {
      if (!visited.has(dep.blockedId)) {
        visited.add(dep.blockedId);
        next.push(dep.blockedId);
      }
    }
    queue = next;
  }

  return false;
}

export async function addDependency(blockedId: string, blockerId: string, userId: string) {
  const { projectId } = await checkCardAccess(blockedId, userId);
  const blockerAccess = await checkCardAccess(blockerId, userId);

  if (blockerAccess.projectId !== projectId) {
    throw new ValidationError("Bağımlılık aynı proje içindeki kartlar arasında olmalı");
  }

  if (blockerId === blockedId) {
    throw new ValidationError("Bir kart kendisini bloklayamaz");
  }

  const existing = await prisma.cardDependency.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
  });
  if (existing) throw new ConflictError("Bu bağımlılık zaten ekli");

  if (await wouldCreateCycle(blockerId, blockedId)) {
    throw new ValidationError("Bu bağımlılık döngü oluşturur");
  }

  const dependency = await prisma.cardDependency.create({
    data: { blockerId, blockedId },
    include: {
      blocker: { select: { id: true, title: true } },
      blocked: { select: { id: true, title: true } },
    },
  });

  broadcastToProject(projectId, SocketEvents.DEPENDENCY_ADDED, {
    projectId,
    blockedId,
    blockerId,
  });

  await logActivity({
    projectId,
    userId,
    type: "DEPENDENCY_ADDED",
    cardId: blockedId,
    data: { blockerTitle: dependency.blocker.title, blockedTitle: dependency.blocked.title },
  });

  return dependency;
}

export async function removeDependency(blockedId: string, blockerId: string, userId: string) {
  const { projectId } = await checkCardAccess(blockedId, userId);

  const dependency = await prisma.cardDependency.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
  });
  if (!dependency) throw new NotFoundError("Bağımlılık");

  await prisma.cardDependency.delete({
    where: { blockerId_blockedId: { blockerId, blockedId } },
  });

  broadcastToProject(projectId, SocketEvents.DEPENDENCY_REMOVED, {
    projectId,
    blockedId,
    blockerId,
  });
}

// Bir kart Done sütununa taşındığında, onu bekleyen (blocked) kartların
// atanan kişilerine (yoksa oluşturana) BLOCKER_RESOLVED bildirimi gönder.
export async function notifyBlockerResolved(blockerCardId: string, blockerTitle: string) {
  const dependents = await prisma.cardDependency.findMany({
    where: { blockerId: blockerCardId },
    select: {
      blocked: {
        select: {
          id: true,
          title: true,
          creatorId: true,
          assignees: { select: { userId: true } },
        },
      },
    },
  });

  for (const dep of dependents) {
    const targetUserIds =
      dep.blocked.assignees.length > 0
        ? dep.blocked.assignees.map((a) => a.userId)
        : [dep.blocked.creatorId];

    for (const targetUserId of targetUserIds) {
      await notificationService.createNotification({
        userId: targetUserId,
        type: "BLOCKER_RESOLVED",
        message: `"${blockerTitle}" tamamlandı, "${dep.blocked.title}" artık bloklanmıyor`,
        cardId: dep.blocked.id,
      });
    }
  }
}
