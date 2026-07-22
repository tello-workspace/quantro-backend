import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import type { Priority } from "@prisma/client";

const STALE_DAYS = 7;
const DEADLINE_RISK_DAYS = 3;
const BLOCKED_STALE_DAYS = 5;
const OVERLOAD_MULTIPLIER = 1.5;

const PRIORITY_WEIGHT: Record<Priority, number> = {
  URGENT: 3,
  HIGH: 2,
  MEDIUM: 1,
  LOW: 1,
};

async function checkProjectAccess(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  if (!project) throw new NotFoundError("Proje");

  const member = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId: project.organizationId, userId },
    },
  });
  if (!member) throw new ForbiddenError("Bu projeye erişim yetkiniz yok");
}

export async function getProjectInsights(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000);
  const blockedStaleThreshold = new Date(now.getTime() - BLOCKED_STALE_DAYS * 24 * 60 * 60 * 1000);
  const deadlineThreshold = new Date(now.getTime() + DEADLINE_RISK_DAYS * 24 * 60 * 60 * 1000);

  // "Done" olmayan sütunlardaki tüm kartlar - stale/is yükü/deadline hesabının hepsi bu küme üzerinden
  const activeCards = await prisma.card.findMany({
    where: { column: { projectId, isDone: false } },
    select: {
      id: true,
      title: true,
      priority: true,
      dueDate: true,
      lastActivityAt: true,
      columnId: true,
      column: { select: { id: true, name: true } },
      assignees: { select: { userId: true, user: { select: { id: true, name: true } } } },
      blockedBy: {
        select: { blocker: { select: { id: true, column: { select: { isDone: true } } } } },
      },
    },
  });

  const staleCards = activeCards
    .filter((c) => c.lastActivityAt < staleThreshold)
    .sort((a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime())
    .map((c) => ({
      id: c.id,
      title: c.title,
      columnId: c.columnId,
      columnName: c.column.name,
      lastActivityAt: c.lastActivityAt.toISOString(),
      assignees: c.assignees.map((a) => a.user),
    }));

  // Iş yükü dengesi: Done disindaki kartlari assignee'ye gore GROUP BY,
  // oncelik agirlikli say (URGENT=3, HIGH=2, diger=1). Ortalamanin 1.5 kati
  // ustundeki kisi "asiri yuklu" isaretlenir.
  const workloadMap = new Map<
    string,
    { user: { id: string; name: string }; weightedLoad: number; cardCount: number }
  >();
  for (const card of activeCards) {
    const weight = PRIORITY_WEIGHT[card.priority];
    for (const assignee of card.assignees) {
      const entry = workloadMap.get(assignee.userId) ?? {
        user: assignee.user,
        weightedLoad: 0,
        cardCount: 0,
      };
      entry.weightedLoad += weight;
      entry.cardCount += 1;
      workloadMap.set(assignee.userId, entry);
    }
  }

  const workloadEntries = Array.from(workloadMap.values());
  const averageLoad =
    workloadEntries.length > 0
      ? workloadEntries.reduce((sum, e) => sum + e.weightedLoad, 0) / workloadEntries.length
      : 0;

  const workload = workloadEntries
    .map((e) => ({
      userId: e.user.id,
      userName: e.user.name,
      cardCount: e.cardCount,
      weightedLoad: e.weightedLoad,
      overloaded: averageLoad > 0 && e.weightedLoad > averageLoad * OVERLOAD_MULTIPLIER,
    }))
    .sort((a, b) => b.weightedLoad - a.weightedLoad);

  // Darbogaz: aktif kart sayisi wipLimit'i asan sutunlar
  const columnsWithLimit = await prisma.column.findMany({
    where: { projectId, wipLimit: { not: null } },
    select: { id: true, name: true, wipLimit: true, _count: { select: { cards: true } } },
  });

  const wipViolations = columnsWithLimit
    .filter((col) => col.wipLimit !== null && col._count.cards > col.wipLimit)
    .map((col) => ({
      columnId: col.id,
      columnName: col.name,
      wipLimit: col.wipLimit as number,
      cardCount: col._count.cards,
    }));

  // Deadline risk: dueDate <= 3 gun VE (5+ gundur hareketsiz VEYA hala bloklanmis)
  const deadlineRisks = activeCards
    .filter((c) => {
      if (!c.dueDate || c.dueDate > deadlineThreshold) return false;
      const isStale = c.lastActivityAt < blockedStaleThreshold;
      const isBlocked = c.blockedBy.some((dep) => !dep.blocker.column.isDone);
      return isStale || isBlocked;
    })
    .sort((a, b) => (a.dueDate as Date).getTime() - (b.dueDate as Date).getTime())
    .map((c) => ({
      id: c.id,
      title: c.title,
      columnId: c.columnId,
      columnName: c.column.name,
      dueDate: (c.dueDate as Date).toISOString(),
      assignees: c.assignees.map((a) => a.user),
    }));

  return {
    generatedAt: now.toISOString(),
    staleCards,
    workload,
    wipViolations,
    deadlineRisks,
  };
}

// Activity tablosu hicbir serviste yazilmiyor (hep bos), o yuzden haftalik ozeti
// Card tablosunun kendi zaman damgalarindan cikariyoruz - tam bir audit log degil
// ama "bu hafta ne oldu" sorusuna yeterli bir yaklasik cevap verir.
export async function getWeeklySummary(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [createdCards, completedCards, newComments, pendingStaleCount] = await Promise.all([
    prisma.card.findMany({
      where: { column: { projectId }, createdAt: { gte: since } },
      select: { creatorId: true, creator: { select: { id: true, name: true } } },
    }),
    prisma.card.findMany({
      where: { column: { projectId, isDone: true }, updatedAt: { gte: since } },
      select: { id: true },
    }),
    prisma.comment.findMany({
      where: { card: { column: { projectId } }, createdAt: { gte: since } },
      select: { authorId: true, author: { select: { id: true, name: true } } },
    }),
    prisma.card.count({
      where: {
        column: { projectId, isDone: false },
        lastActivityAt: { lt: new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  const activityCount = new Map<string, { user: { id: string; name: string }; count: number }>();
  for (const card of createdCards) {
    const entry = activityCount.get(card.creatorId) ?? { user: card.creator, count: 0 };
    entry.count += 1;
    activityCount.set(card.creatorId, entry);
  }
  for (const comment of newComments) {
    const entry = activityCount.get(comment.authorId) ?? { user: comment.author, count: 0 };
    entry.count += 1;
    activityCount.set(comment.authorId, entry);
  }

  const mostActive = Array.from(activityCount.values()).sort((a, b) => b.count - a.count)[0];

  return {
    since: since.toISOString(),
    cardsCreated: createdCards.length,
    cardsCompleted: completedCards.length,
    commentsAdded: newComments.length,
    mostActiveMember: mostActive
      ? { userId: mostActive.user.id, userName: mostActive.user.name, activityCount: mostActive.count }
      : null,
    pendingStaleCount,
  };
}
