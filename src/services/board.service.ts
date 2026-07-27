import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";

// Proje + uyelik tek sorguda: onceden proje bir sorgu, uyelik ayri bir
// sorgu ile cekiliyordu (iki gidis-donus). Iliski uzerinden filtreleyerek
// ikisini birlestiriyoruz; proje yok mu yoksa uye degil mi ayrimi icin
// yalnizca hata yolunda ikinci sorguyu atiyoruz.
async function checkProjectAccess(projectId: string, userId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, organization: { members: { some: { userId } } } },
    select: { organization: { select: { members: { where: { userId }, select: { role: true } } } } },
  });

  if (project) return { role: project.organization.members[0].role };

  const exists = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!exists) throw new NotFoundError("Proje");
  throw new ForbiddenError("Bu projeye erişim yetkiniz yok");
}

export async function getBoard(projectId: string, userId: string) {
  // Uzak veritabaninda her sorgu ~140ms. Erisim kontrolu pano sorgusundan
  // once sirayla beklenirse bu bedel iki kez daha odeniyor; ikisini paralel
  // baslatip yetki hatasini yine de veriyi donmeden firlatiyoruz.
  //
  // relationLoadStrategy: "join" ise ic ice include'lari (assignees -> user,
  // labels -> label) ayri sorgular yerine tek SQL'de topluyor: 6 sorgu -> 1.
  const [access, columns] = await Promise.all([
    checkProjectAccess(projectId, userId),
    prisma.column.findMany({
      where: { projectId },
      orderBy: { position: "asc" },
      relationLoadStrategy: "join",
      include: {
        cards: {
          orderBy: { position: "asc" },
          include: {
            assignees: { include: { user: { select: { id: true, name: true } } } },
            labels: { include: { label: true } },
          },
        },
      },
    }),
  ]);

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
        position: card.position,
        priority: card.priority,
        lastActivityAt: card.lastActivityAt.toISOString(),
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

  return { columns: boardColumns, tasks, myRole: access.role };
}
