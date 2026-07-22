import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";

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

export async function getBoard(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  const columns = await prisma.column.findMany({
    where: { projectId },
    orderBy: { position: "asc" },
    include: {
      cards: {
        orderBy: { position: "asc" },
        include: {
          assignees: { include: { user: { select: { id: true, name: true } } } },
          labels: { include: { label: true } },
        },
      },
    },
  });

  const boardColumns: Record<string, { id: string; title: string; wipLimit: number | null; taskIds: string[] }> = {};
  const tasks: Record<string, unknown> = {};

  for (const col of columns) {
    const taskIds: string[] = [];
    for (const card of col.cards) {
      taskIds.push(card.id);
      tasks[card.id] = {
        id: card.id,
        title: card.title,
        description: card.description,
        dueDate: card.dueDate?.toISOString().split("T")[0],
        columnId: card.columnId,
        assignees: card.assignees.map((a) => ({ id: a.user.id, name: a.user.name })),
        labels: card.labels.map((cl) => ({
          id: cl.label.id,
          name: cl.label.name,
          color: cl.label.color,
        })),
      };
    }
    boardColumns[col.id] = {
      id: col.id,
      title: col.name,
      wipLimit: col.wipLimit,
      taskIds,
    };
  }

  return { columns: boardColumns, tasks };
}
