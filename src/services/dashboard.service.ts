import { prisma } from "@/lib/prisma";
import { filterVisibleProjects } from "@/services/access-control.service";

// Kullanicinin uye oldugu TUM organizasyonlardaki projelerde uzerine atanmis
// (Done sutunundaki kartlar haric) tum kartlar - "Bana atananlar" panosu.
// Tek bir proje acmadan "uzerimde ne var" sorusuna cevap verir.
export async function getMyAssignedCards(userId: string) {
  const cards = await prisma.card.findMany({
    where: {
      assignees: { some: { userId } },
      column: {
        isDone: false,
        // UYELIK SART. CardAssignee kaydi kisi organizasyondan cikarilinca
        // silinmiyor (karta ve kullaniciya bagli, uyelige degil); bu filtre
        // olmadan org'dan atilan biri kart basligini, onceligini, teslim
        // tarihini ve etiketlerini CANLI okumaya devam ediyordu. Atama kaydini
        // silmek yerine filtre tercih edildi ki kisi tekrar uye olursa listesi
        // kaldigi yerden dolsun (watcher.service.getWatchedCards ile ayni desen).
        project: { organization: { members: { some: { userId } } } },
      },
      isArchived: false,
    },
    select: {
      id: true,
      title: true,
      priority: true,
      dueDate: true,
      lastActivityAt: true,
      columnId: true,
      column: {
        select: {
          id: true,
          name: true,
          // ownerId/visibility yalnizca asagidaki gorunurluk suzgeci icin
          // cekiliyor, cevaba konmuyor.
          project: {
            select: {
              id: true,
              name: true,
              ownerId: true,
              visibility: true,
              organizationId: true,
              organization: { select: { name: true } },
            },
          },
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

  // Org uyeligi tek basina yetmiyor: PRIVATE/TEAM projeden ProjectMember
  // olarak cikarilan ya da GUEST'e dusurulen kisinin atamasi duruyor ve kart
  // yine listeleniyordu. Gorunurluk kuralini board ile ayni kaynaktan
  // (filterVisibleProjects) uyguluyoruz - burada ikinci bir kural yazilmasin.
  // Rol organizasyon basina degistigi icin projeleri org'a gore gruplayip her
  // grubu kendi rolu ile suzuyoruz.
  const rolePerOrg = new Map(
    (
      await prisma.organizationMember.findMany({
        where: { userId },
        select: { organizationId: true, role: true },
      })
    ).map((m) => [m.organizationId, m.role] as const),
  );

  type AtananProje = (typeof cards)[number]["column"]["project"];
  const orgGruplari = new Map<string, Map<string, AtananProje>>();
  for (const c of cards) {
    const p = c.column.project;
    const grup = orgGruplari.get(p.organizationId) ?? new Map<string, AtananProje>();
    grup.set(p.id, p);
    orgGruplari.set(p.organizationId, grup);
  }

  const gorunurProjeIds = new Set<string>();
  for (const [organizationId, grup] of orgGruplari) {
    const role = rolePerOrg.get(organizationId);
    if (!role) continue;
    const gorunur = await filterVisibleProjects([...grup.values()], userId, role);
    for (const p of gorunur) gorunurProjeIds.add(p.id);
  }

  return cards
    .filter((c) => gorunurProjeIds.has(c.column.project.id))
    .map((c) => ({
      id: c.id,
      title: c.title,
      priority: c.priority,
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
