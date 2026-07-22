import { prisma } from "@/lib/prisma";
import * as notificationService from "@/services/notification.service";
import type { NotificationType } from "@prisma/client";

const STALE_DAYS = 7;
const DEADLINE_RISK_HOURS = 48;

// Ayni kart/sutun icin okunmamis bir bildirim zaten varsa tekrar
// olusturma - aksi halde her gece ayni sey icin spam atariz.
async function notifyOnce(
  userId: string,
  type: NotificationType,
  message: string,
  cardId?: string,
) {
  const existing = await prisma.notification.findFirst({
    where: { userId, type, message, read: false },
  });
  if (existing) return;

  await notificationService.createNotification({ userId, type, message, cardId });
}

// "Done" olmayan bir sutunda 7+ gundur hareketsiz kalan kartlar
export async function scanStaleCards() {
  const threshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  const staleCards = await prisma.card.findMany({
    where: {
      lastActivityAt: { lt: threshold },
      column: { isDone: false },
    },
    select: { id: true, title: true, creatorId: true, assignees: { select: { userId: true } } },
  });

  for (const card of staleCards) {
    const targetUserIds = card.assignees.length > 0 ? card.assignees.map((a) => a.userId) : [card.creatorId];
    for (const targetUserId of targetUserIds) {
      await notifyOnce(
        targetUserId,
        "STALE_CARD",
        `"${card.title}" kartı ${STALE_DAYS} günden uzun süredir hareketsiz`,
        card.id,
      );
    }
  }

  return staleCards.length;
}

// Teslim tarihi 48 saat icinde olan, henuz bitmemis kartlar
export async function scanDeadlineRisk() {
  const now = new Date();
  const soon = new Date(now.getTime() + DEADLINE_RISK_HOURS * 60 * 60 * 1000);

  const riskyCards = await prisma.card.findMany({
    where: {
      dueDate: { gte: now, lte: soon },
      column: { isDone: false },
    },
    select: { id: true, title: true, creatorId: true, assignees: { select: { userId: true } } },
  });

  for (const card of riskyCards) {
    const targetUserIds = card.assignees.length > 0 ? card.assignees.map((a) => a.userId) : [card.creatorId];
    for (const targetUserId of targetUserIds) {
      await notifyOnce(
        targetUserId,
        "DEADLINE_RISK",
        `"${card.title}" kartının teslim tarihi 48 saat içinde`,
        card.id,
      );
    }
  }

  return riskyCards.length;
}

// Aktif kart sayisi WIP limitini asan sutunlar - proje sahibine haber ver
export async function scanWipExceeded() {
  const columns = await prisma.column.findMany({
    where: { wipLimit: { not: null } },
    select: {
      id: true,
      name: true,
      wipLimit: true,
      project: { select: { ownerId: true } },
      _count: { select: { cards: true } },
    },
  });

  let flagged = 0;
  for (const col of columns) {
    if (col.wipLimit !== null && col._count.cards > col.wipLimit) {
      flagged += 1;
      await notifyOnce(
        col.project.ownerId,
        "WIP_EXCEEDED",
        `"${col.name}" sütunu WIP limitini (${col.wipLimit}) aştı`,
      );
    }
  }

  return flagged;
}

export async function runNightlyScan() {
  const [stale, deadlineRisk, wipExceeded] = await Promise.all([
    scanStaleCards(),
    scanDeadlineRisk(),
    scanWipExceeded(),
  ]);

  console.log(
    `[scan] stale=${stale} deadlineRisk=${deadlineRisk} wipExceeded=${wipExceeded}`,
  );

  return { stale, deadlineRisk, wipExceeded };
}
