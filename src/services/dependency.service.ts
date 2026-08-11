import { prisma } from "@/lib/prisma";
import { NotFoundError, ConflictError, ValidationError } from "@/utils/errors";
import { checkCardAccess } from "@/services/access-control.service";
import * as notificationService from "@/services/notification.service";
import { logActivity } from "@/services/activity.service";
import { broadcastToProject, SocketEvents } from "@/server/socket";
import type { DependencyRelationType } from "@prisma/client";

// blockerId'den blockedId'ye yeni bir "blocker -> blocked" kenari eklersek
// dongu olusur mu? blockedId'den baslayip mevcut "blocking" kenarlarini takip
// ederek blockerId'ye ulasilabiliyorsa, yeni kenar bir dongu kapatir.
// Sadece BLOCKS tipi kenarlar gercek bir "bekleme" iliskisi kurdugu icin
// dongu grafigi de sadece bu tip kenarlardan olusur - RELATES_TO/DUPLICATES/
// CLONES kenarlari burada goz ardi edilir.
async function wouldCreateCycle(blockerId: string, blockedId: string): Promise<boolean> {
  if (blockerId === blockedId) return true;

  const visited = new Set<string>([blockedId]);
  let queue = [blockedId];

  while (queue.length > 0) {
    if (queue.includes(blockerId)) return true;

    const deps = await prisma.cardDependency.findMany({
      where: { blockerId: { in: queue }, relationType: "BLOCKS" },
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

export async function addDependency(
  blockedId: string,
  blockerId: string,
  userId: string,
  relationType: DependencyRelationType = "BLOCKS",
) {
  const { projectId } = await checkCardAccess(blockedId, userId);
  const blockerAccess = await checkCardAccess(blockerId, userId);

  if (blockerAccess.projectId !== projectId) {
    throw new ValidationError("Bağımlılık aynı proje içindeki kartlar arasında olmalı");
  }

  if (blockerId === blockedId) {
    throw new ValidationError("Bir kart kendisiyle ilişkilendirilemez");
  }

  const existing = await prisma.cardDependency.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
  });
  if (existing) throw new ConflictError("Bu ilişki zaten ekli");

  // RELATES_TO/DUPLICATES/CLONES yonsuz kabul edilir: A->B varken B->A'nin
  // tekrar eklenmesi ayni iliskinin mukerreri olur. BLOCKS yonlu oldugu icin
  // (A B'yi bloklar != B A'yi bloklar) bu kontrole tabi degil.
  if (relationType !== "BLOCKS") {
    const reverse = await prisma.cardDependency.findUnique({
      where: { blockerId_blockedId: { blockerId: blockedId, blockedId: blockerId } },
    });
    if (reverse) throw new ConflictError("Bu ilişki zaten ekli");
  }

  if (relationType === "BLOCKS" && (await wouldCreateCycle(blockerId, blockedId))) {
    throw new ValidationError("Bu bağımlılık döngü oluşturur");
  }

  const dependency = await prisma.cardDependency.create({
    data: { blockerId, blockedId, relationType },
    include: {
      blocker: { select: { id: true, title: true } },
      blocked: { select: { id: true, title: true } },
    },
  });

  broadcastToProject(projectId, SocketEvents.DEPENDENCY_ADDED, {
    projectId,
    blockedId,
    blockerId,
    relationType,
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
    where: { blockerId: blockerCardId, relationType: "BLOCKS" },
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
