import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ValidationError } from "@/utils/errors";
import { broadcastToProject, SocketEvents } from "@/server/socket";
import type { CreateSprintInput, UpdateSprintInput } from "@/schemas/sprint.schema";

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

async function checkProjectAdmin(projectId: string, userId: string) {
  const { role } = await checkProjectAccess(projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Sprint'leri sadece adminler yönetebilir");
}

export async function listSprints(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);
  return prisma.sprint.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { cards: true } } },
  });
}

export async function createSprint(projectId: string, input: CreateSprintInput, userId: string) {
  await checkProjectAdmin(projectId, userId);

  const sprint = await prisma.sprint.create({
    data: {
      projectId,
      name: input.name,
      goal: input.goal ?? undefined,
      startDate: input.startDate ? new Date(input.startDate) : undefined,
      endDate: input.endDate ? new Date(input.endDate) : undefined,
    },
  });

  broadcastToProject(projectId, SocketEvents.SPRINT_CREATED, {
    id: sprint.id,
    projectId,
    name: sprint.name,
    status: sprint.status,
  });

  return sprint;
}

export async function updateSprint(sprintId: string, input: UpdateSprintInput, userId: string) {
  const sprint = await prisma.sprint.findUnique({ where: { id: sprintId } });
  if (!sprint) throw new NotFoundError("Sprint");
  await checkProjectAdmin(sprint.projectId, userId);

  // Bir projede ayni anda sadece bir ACTIVE sprint olsun - Jira'daki gibi
  // paralel aktif sprint karisikligini onler.
  if (input.status === "ACTIVE" && sprint.status !== "ACTIVE") {
    const existingActive = await prisma.sprint.findFirst({
      where: { projectId: sprint.projectId, status: "ACTIVE", id: { not: sprintId } },
    });
    if (existingActive) {
      throw new ValidationError(`"${existingActive.name}" zaten aktif. Önce onu tamamlayın.`);
    }
  }

  const updated = await prisma.sprint.update({
    where: { id: sprintId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.goal !== undefined && { goal: input.goal }),
      ...(input.startDate !== undefined && { startDate: input.startDate ? new Date(input.startDate) : null }),
      ...(input.endDate !== undefined && { endDate: input.endDate ? new Date(input.endDate) : null }),
      ...(input.status !== undefined && { status: input.status }),
    },
  });

  broadcastToProject(sprint.projectId, SocketEvents.SPRINT_UPDATED, {
    id: updated.id,
    projectId: sprint.projectId,
    name: updated.name,
    status: updated.status,
  });

  return updated;
}

export async function deleteSprint(sprintId: string, userId: string) {
  const sprint = await prisma.sprint.findUnique({ where: { id: sprintId } });
  if (!sprint) throw new NotFoundError("Sprint");
  await checkProjectAdmin(sprint.projectId, userId);

  // Kartlar silinmez, sadece sprint'ten cikarilir (Card.sprintId onDelete: SetNull)
  await prisma.sprint.delete({ where: { id: sprintId } });

  broadcastToProject(sprint.projectId, SocketEvents.SPRINT_DELETED, { id: sprintId, projectId: sprint.projectId });
}

// Sprint panelinde ve burndown grafiginde kullanilir: sprint'e bagli tum
// kartlarin story point/kolon/tamamlanma durumu.
export async function getSprintCards(sprintId: string, userId: string) {
  const sprint = await prisma.sprint.findUnique({ where: { id: sprintId } });
  if (!sprint) throw new NotFoundError("Sprint");
  await checkProjectAccess(sprint.projectId, userId);

  return prisma.card.findMany({
    where: { sprintId },
    select: {
      id: true,
      title: true,
      storyPoints: true,
      columnId: true,
      column: { select: { name: true, isDone: true } },
      assignees: { select: { user: { select: { id: true, name: true } } } },
    },
    orderBy: { position: "asc" },
  });
}
