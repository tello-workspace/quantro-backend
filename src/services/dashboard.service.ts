import { prisma } from "@/lib/prisma";

// Kullanicinin uye oldugu TUM organizasyonlardaki projelerde uzerine atanmis
// (Done sutunundaki kartlar haric) tum kartlar - "Bana atananlar" panosu.
// Tek bir proje acmadan "uzerimde ne var" sorusuna cevap verir.
export async function getMyAssignedCards(userId: string) {
  const cards = await prisma.card.findMany({
    where: {
      assignees: { some: { userId } },
      column: { isDone: false },
    },
    select: {
      id: true,
      title: true,
      priority: true,
      storyPoints: true,
      dueDate: true,
      lastActivityAt: true,
      columnId: true,
      column: {
        select: {
          id: true,
          name: true,
          project: { select: { id: true, name: true, organizationId: true, organization: { select: { name: true } } } },
        },
      },
      labels: { include: { label: true } },
      blockedBy: {
        where: { relationType: "BLOCKS" },
        select: { blocker: { select: { id: true, title: true, column: { select: { isDone: true } } } } },
      },
    },
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { priority: "desc" }],
  });

  return cards.map((c) => ({
    id: c.id,
    title: c.title,
    priority: c.priority,
    storyPoints: c.storyPoints,
    dueDate: c.dueDate?.toISOString() ?? null,
    lastActivityAt: c.lastActivityAt.toISOString(),
    columnId: c.columnId,
    columnName: c.column.name,
    projectId: c.column.project.id,
    projectName: c.column.project.name,
    organizationId: c.column.project.organizationId,
    organizationName: c.column.project.organization.name,
    labels: c.labels.map((cl) => cl.label),
    isBlocked: c.blockedBy.some((d) => !d.blocker.column.isDone),
  }));
}
