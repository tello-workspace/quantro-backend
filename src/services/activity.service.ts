import { prisma } from "@/lib/prisma";
import { checkProjectAccess } from "@/services/access-control.service";
import type { ActivityType, Prisma } from "@prisma/client";

interface LogActivityInput {
  projectId: string;
  userId: string;
  type: ActivityType;
  cardId?: string;
  data?: Prisma.InputJsonValue;
}

// Servis katmanindaki mutasyon noktalarindan (kart/yorum/bagimlilik) cagrilir.
// Bildirimlerin aksine kullanicidan bagimsiz, sessizce loglar - hata firlatmaz
// gibi davranmasi beklenmez ama cagiran islemi bozmamasi icin catch edilir.
export async function logActivity(input: LogActivityInput) {
  try {
    await prisma.activity.create({
      data: {
        projectId: input.projectId,
        userId: input.userId,
        type: input.type,
        cardId: input.cardId,
        data: input.data,
      },
    });
  } catch (error) {
    console.error("[activity] loglanamadı:", error);
  }
}

export async function getProjectActivities(projectId: string, userId: string, limit = 50) {
  await checkProjectAccess(projectId, userId);

  return prisma.activity.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      // avatarUrl: aktivite akisi her kaydin yaninda islemi yapan kisinin
      // avatarini gosteriyor.
      user: { select: { id: true, name: true, avatarUrl: true } },
      card: { select: { id: true, title: true } },
    },
  });
}
