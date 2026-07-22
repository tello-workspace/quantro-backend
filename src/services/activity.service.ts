import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import type { ActivityType, Prisma } from "@prisma/client";

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
      user: { select: { id: true, name: true } },
      card: { select: { id: true, title: true } },
    },
  });
}
