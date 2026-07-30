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
        // Onceden hic limit yoktu - tek bir kolonda binlerce kart biriken bir
        // proje (en cok "Done" kolonu, hic temizlenmediginde) tum kartlari
        // tek istekte serialize etmeye calisirdi. Kart bazli gercek sayfalama
        // (cursor + "daha fazla yukle" UI'i) board'un tek-seferde-yukle
        // yapisini degistirmeyi gerektirir - bu, sinirsiz buyumeyi durduran
        // savunma amacli bir tavan. Normal boyuttaki bir projede hicbir
        // kolon bu sayiya yaklasmaz.
        cards: {
          take: 500,
          orderBy: { position: "asc" },
          include: {
            assignees: { include: { user: { select: { id: true, name: true, badges: { include: { badge: { select: { id: true, name: true, color: true, icon: true } } } } } } } },
            labels: { include: { label: true } },
            // Panoda sadece "3/7" ilerleme rozeti icin - madde metinleri
            // TaskModal acilinca ayri bir istekle cekiliyor.
            checklistItems: { select: { done: true } },
          },
        },
      },
    }),
  ]);

  const boardColumns: Record<string, { id: string; title: string; wipLimit: number | null; isDone: boolean; taskIds: string[] }> = {};
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
        storyPoints: card.storyPoints,
        lastActivityAt: card.lastActivityAt.toISOString(),
        assignees: card.assignees.map((a) => ({ id: a.user.id, name: a.user.name })),
        labels: card.labels.map((cl) => ({
          id: cl.label.id,
          name: cl.label.name,
          color: cl.label.color,
        })),
        checklistTotal: card.checklistItems.length,
        checklistDone: card.checklistItems.filter((c) => c.done).length,
      };
    }
    boardColumns[col.id] = {
      id: col.id,
      title: col.name,
      wipLimit: col.wipLimit,
      isDone: col.isDone,
      taskIds,
    };
  }

  return { columns: boardColumns, tasks, myRole: access.role };
}
