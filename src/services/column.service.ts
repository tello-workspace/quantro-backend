import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import { broadcastToProject, SocketEvents } from "@/server/socket";
import type { CreateColumnInput, UpdateColumnInput } from "@/schemas/column.schema";

// Projenin organizasyonuna üye mi kontrol et
async function checkProjectAccess(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  if (!project) throw new NotFoundError("Proje");

  const member = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: project.organizationId,
        userId,
      },
    },
  });
  if (!member) throw new ForbiddenError("Bu projeye erişim yetkiniz yok");

  return { role: member.role };
}

export async function createColumn(projectId: string, input: CreateColumnInput, userId: string) {
  const { role } = await checkProjectAccess(projectId, userId);
  // Yapisal degisiklik: uye dogrudan yapamaz, talep acar
  if (role !== "ADMIN") {
    throw new ForbiddenError(
      "Sütunu sadece adminler oluşturabilir. Sütun talebi gönderebilirsiniz.",
    );
  }

  // Pozisyon verilmemişse sona ekle
  let position = input.position;
  if (position === undefined) {
    const lastColumn = await prisma.column.findFirst({
      where: { projectId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    position = (lastColumn?.position ?? 0) + 1;
  }

  const column = await prisma.column.create({
    data: {
      projectId,
      name: input.name,
      position,
      wipLimit: input.wipLimit,
      isDone: input.isDone ?? false,
    },
  });

<<<<<<< Updated upstream
=======
  // Emit real-time event
>>>>>>> Stashed changes
  broadcastToProject(projectId, SocketEvents.COLUMN_CREATED, {
    id: column.id,
    name: column.name,
    projectId,
    position: column.position,
<<<<<<< Updated upstream
    wipLimit: column.wipLimit ?? null,
=======
    wipLimit: column.wipLimit,
>>>>>>> Stashed changes
    isDone: column.isDone,
  });

  return column;
}

export async function getColumns(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  const columns = await prisma.column.findMany({
    where: { projectId },
    orderBy: { position: "asc" },
    include: {
      _count: { select: { cards: true } },
    },
  });

  return columns;
}

export async function getColumnById(columnId: string, userId: string) {
  const column = await prisma.column.findUnique({ where: { id: columnId } });
  if (!column) throw new NotFoundError("Sütun");

  await checkProjectAccess(column.projectId, userId);

  return column;
}

export async function updateColumn(columnId: string, input: UpdateColumnInput, userId: string) {
  const column = await prisma.column.findUnique({ where: { id: columnId } });
  if (!column) throw new NotFoundError("Sütun");

  await checkProjectAccess(column.projectId, userId);

  const updated = await prisma.column.update({
    where: { id: columnId },
    data: input,
  });

<<<<<<< Updated upstream
=======
  // Emit real-time event
>>>>>>> Stashed changes
  broadcastToProject(column.projectId, SocketEvents.COLUMN_UPDATED, {
    id: updated.id,
    name: updated.name,
    projectId: column.projectId,
    position: updated.position,
<<<<<<< Updated upstream
    wipLimit: updated.wipLimit ?? null,
=======
    wipLimit: updated.wipLimit,
>>>>>>> Stashed changes
    isDone: updated.isDone,
  });

  return updated;
}

export async function deleteColumn(columnId: string, userId: string) {
  const column = await prisma.column.findUnique({ where: { id: columnId } });
  if (!column) throw new NotFoundError("Sütun");

  await checkProjectAccess(column.projectId, userId);

  await prisma.column.delete({ where: { id: columnId } });

<<<<<<< Updated upstream
  broadcastToProject(column.projectId, SocketEvents.COLUMN_DELETED, {
    columnId,
    projectId: column.projectId,
=======
  // Emit real-time event
  broadcastToProject(column.projectId, SocketEvents.COLUMN_DELETED, {
    columnId,
    projectId: column.projectId,
    deletedBy: userId,
>>>>>>> Stashed changes
  });
}

export async function reorderColumns(projectId: string, columnIds: string[], userId: string) {
  await checkProjectAccess(projectId, userId);

  // Batch update: gelen sıraya göre position'ları 0, 1, 2... yap
  const updates = columnIds.map((id, index) =>
    prisma.column.update({
      where: { id },
      data: { position: index },
    }),
  );

  await prisma.$transaction(updates);

  return prisma.column.findMany({
    where: { projectId },
    orderBy: { position: "asc" },
  });
}
