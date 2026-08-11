import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import type { Prisma } from "@prisma/client";
import type { CreateSavedViewInput } from "@/schemas/saved-view.schema";

async function checkProjectAccess(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  if (!project) throw new NotFoundError("Proje");

  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: project.organizationId, userId } },
  });
  if (!member) throw new ForbiddenError("Bu projeye erişim yetkiniz yok");

  return { role: member.role };
}

// Kendi gorunumlerin + baskalarinin PAYLASTIGI gorunumler - board'daki filtre
// menusune tek listede dolduruluyor, "benim" / "paylasilan" ayrimini
// frontend isShared alanina bakarak kendisi yapiyor.
export async function listSavedViews(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  return prisma.savedView.findMany({
    where: { projectId, OR: [{ ownerId: userId }, { isShared: true }] },
    orderBy: { createdAt: "asc" },
    include: { owner: { select: { id: true, name: true } } },
  });
}

export async function createSavedView(projectId: string, input: CreateSavedViewInput, userId: string) {
  await checkProjectAccess(projectId, userId);

  return prisma.savedView.create({
    data: {
      projectId,
      ownerId: userId,
      name: input.name,
      filters: input.filters as Prisma.InputJsonValue,
      isShared: input.isShared ?? false,
    },
    include: { owner: { select: { id: true, name: true } } },
  });
}

// Sadece sahibi silebilir - "paylasilan" baskasinin kaydettigi kisayolu
// herkes gorebilir ama yalnizca sahibi kaldirabilir/degistirebilir.
export async function deleteSavedView(viewId: string, userId: string) {
  const view = await prisma.savedView.findUnique({ where: { id: viewId }, select: { ownerId: true } });
  if (!view) throw new NotFoundError("Görünüm");
  if (view.ownerId !== userId) throw new ForbiddenError("Bu görünümü sadece sahibi silebilir");

  await prisma.savedView.delete({ where: { id: viewId } });
}
