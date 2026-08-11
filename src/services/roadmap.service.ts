import { prisma } from "@/lib/prisma";
import { checkProjectAccess } from "@/services/access-control.service";

// Yol haritasi panodan FARKLI bir veri sekli istiyor: pano bagimliliklari ve
// epic hiyerarsisini tasimiyor (kart acilinca ayrica cekiliyor), yol haritasi
// ise ikisini de cizmek zorunda. Panoya bu alanlari eklemek her pano
// yuklemesinde odenen bir maliyet olurdu, o yuzden ayri bir uc nokta.

export async function getProjectRoadmap(projectId: string, userId: string) {
  const [, project] = await Promise.all([
    checkProjectAccess(projectId, userId),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } }),
  ]);

  const cards = await prisma.card.findMany({
    where: {
      column: { projectId },
      isArchived: false,
      // Tarihi olmayan kart zaman cizelgesinde konumlandirilamaz. Bunlari
      // hic cekmiyoruz: buyuk bir panoda cogunlugu olusturabiliyorlar ve
      // gorunumde yer almayacak veriyi tasimanin anlami yok.
      OR: [{ startDate: { not: null } }, { dueDate: { not: null } }],
    },
    orderBy: [{ startDate: "asc" }, { dueDate: "asc" }],
    select: {
      id: true,
      title: true,
      startDate: true,
      dueDate: true,
      priority: true,
      parentCardId: true,
      column: { select: { id: true, name: true, isDone: true } },
      assignees: {
        select: { user: { select: { id: true, name: true, avatarUrl: true } } },
      },
      labels: { select: { label: { select: { id: true, name: true, color: true } } } },
    },
  });

  const cardIds = cards.map((c) => c.id);

  // Yalnizca BLOCKS yonlu bir bekleme anlami tasiyor; RELATES_TO/DUPLICATES/
  // CLONES bilgilendirme amacli oldugu icin zaman cizelgesinde ok cizmek
  // yanlis bir "once bu bitmeli" izlenimi verirdi.
  const dependencies = await prisma.cardDependency.findMany({
    where: {
      relationType: "BLOCKS",
      blockerId: { in: cardIds },
      blockedId: { in: cardIds },
    },
    select: { blockerId: true, blockedId: true },
  });

  // Ust kart (epic) basliklari: gruplama icin gerekli ama ust kartin kendisi
  // tarihsiz olabilir ve yukaridaki sorguya girmemis olabilir.
  const parentIds = [...new Set(cards.map((c) => c.parentCardId).filter((p): p is string => !!p))];
  const parents = parentIds.length
    ? await prisma.card.findMany({
        where: { id: { in: parentIds } },
        select: { id: true, title: true },
      })
    : [];

  return {
    projectId,
    projectName: project.name,
    cards: cards.map((c) => ({
      id: c.id,
      title: c.title,
      startDate: c.startDate?.toISOString() ?? null,
      dueDate: c.dueDate?.toISOString() ?? null,
      priority: c.priority,
      parentCardId: c.parentCardId,
      columnId: c.column.id,
      columnName: c.column.name,
      isDone: c.column.isDone,
      assignees: c.assignees.map((a) => ({
        id: a.user.id,
        name: a.user.name,
        avatarUrl: a.user.avatarUrl,
      })),
      labels: c.labels.map((l) => l.label),
    })),
    dependencies,
    parents,
  };
}
