import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import * as notificationService from "@/services/notification.service";

// Kartın kolonuna → projesine → organizasyonuna erişim kontrolü (comment.service.ts ile aynı desen)
async function checkCardAccess(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { column: { select: { projectId: true, project: { select: { organizationId: true } } } } },
  });
  if (!card) throw new NotFoundError("Kart");

  const member = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId: card.column.project.organizationId, userId },
    },
  });
  if (!member) throw new ForbiddenError("Bu karta erişim yetkiniz yok");
}

export async function getWatchStatus(cardId: string, userId: string) {
  await checkCardAccess(cardId, userId);

  const [isWatching, watcherCount] = await Promise.all([
    prisma.cardWatcher.findUnique({ where: { cardId_userId: { cardId, userId } } }).then((w) => !!w),
    prisma.cardWatcher.count({ where: { cardId } }),
  ]);

  return { isWatching, watcherCount };
}

export async function watchCard(cardId: string, userId: string) {
  await checkCardAccess(cardId, userId);

  await prisma.cardWatcher.upsert({
    where: { cardId_userId: { cardId, userId } },
    create: { cardId, userId },
    update: {},
  });

  return getWatchStatus(cardId, userId);
}

export async function unwatchCard(cardId: string, userId: string) {
  await checkCardAccess(cardId, userId);

  await prisma.cardWatcher.deleteMany({ where: { cardId, userId } });

  return getWatchStatus(cardId, userId);
}

// Kartin izleyicilerine (haber verilen kisi haric) bir bildirim yollar.
// Yorum eklenince (comment.service.ts) ve kart baska bir sutuna tasininca
// (card.service.ts) cagrilir - assignee bildirimlerinden AYRI, birisi hem
// atanmis hem izliyor olabilir, bu durumda iki bildirim de alir (farkli
// anlamlari var: biri "sana atandi", digeri "izledigin kartta hareket var").
export async function notifyWatchers(cardId: string, excludeUserId: string, message: string) {
  const watchers = await prisma.cardWatcher.findMany({
    where: { cardId, userId: { not: excludeUserId } },
    select: { userId: true },
  });

  for (const watcher of watchers) {
    await notificationService.createNotification({
      userId: watcher.userId,
      type: "WATCHED_CARD_ACTIVITY",
      message,
      cardId,
    });
  }
}
