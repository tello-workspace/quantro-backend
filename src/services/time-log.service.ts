import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import { broadcastToProject, SocketEvents } from "@/server/socket";
import { logActivity } from "@/services/activity.service";
import type { CreateTimeLogInput } from "@/schemas/time-log.schema";

async function checkCardAccess(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { columnId: true, column: { select: { projectId: true, project: { select: { organizationId: true } } } } },
  });
  if (!card) throw new NotFoundError("Kart");

  const member = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId: card.column.project.organizationId, userId },
    },
  });
  if (!member) throw new ForbiddenError("Bu karta erişim yetkiniz yok");

  return { projectId: card.column.projectId };
}

export async function listTimeLogs(cardId: string, userId: string) {
  await checkCardAccess(cardId, userId);

  return prisma.timeLog.findMany({
    where: { cardId },
    orderBy: { loggedAt: "desc" },
    include: { user: { select: { id: true, name: true, avatarUrl: true } } },
  });
}

// Zaman kaydi eklemek TIMER degil elle giris - "dun 3 saat calistim" gibi
// gecmise donuk kayit normal, bu yuzden loggedAt serbest (gelecege
// gonderilmesi engellenmiyor, kotuye kullanim riski dusuk ve engellemek
// zaman dilimi sorunlarini gereksiz karmasiklastirirdi).
export async function createTimeLog(cardId: string, input: CreateTimeLogInput, userId: string) {
  const { projectId } = await checkCardAccess(cardId, userId);

  const [log] = await prisma.$transaction([
    prisma.timeLog.create({
      data: {
        cardId,
        userId,
        minutes: input.minutes,
        note: input.note,
        loggedAt: input.loggedAt ? new Date(input.loggedAt) : undefined,
      },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    }),
    prisma.card.update({
      where: { id: cardId },
      data: { spentMinutes: { increment: input.minutes } },
    }),
  ]);

  broadcastToProject(projectId, SocketEvents.CARD_UPDATED, { id: cardId, projectId });

  await logActivity({
    projectId,
    userId,
    type: "CARD_UPDATED",
    cardId,
    data: { timeLogged: input.minutes },
  });

  return log;
}

// Sadece kendi kaydini silebilirsin - baskasinin harcadigi zamani silmek
// gorev takibini yaniltir, admin bile olsa bu yetki verilmedi.
export async function deleteTimeLog(logId: string, userId: string) {
  const log = await prisma.timeLog.findUnique({ where: { id: logId } });
  if (!log) throw new NotFoundError("Zaman kaydı");
  if (log.userId !== userId) throw new ForbiddenError("Sadece kendi zaman kaydınızı silebilirsiniz");

  const { projectId } = await checkCardAccess(log.cardId, userId);

  await prisma.$transaction([
    prisma.timeLog.delete({ where: { id: logId } }),
    prisma.card.update({
      where: { id: log.cardId },
      data: { spentMinutes: { decrement: log.minutes } },
    }),
  ]);

  broadcastToProject(projectId, SocketEvents.CARD_UPDATED, { id: log.cardId, projectId });
}
