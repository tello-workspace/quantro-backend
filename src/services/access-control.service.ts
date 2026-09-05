import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import type { Role, ProjectVisibility } from "@prisma/client";

export interface ProjectAccess {
  role: Role;
  projectId: string;
  organizationId: string;
  visibility: ProjectVisibility;
  isOwner: boolean;
}

// TUM servislerdeki proje erisim kontrolunun TEK gercek kaynagi. Onceden
// her servis (board/card/comment/label/...) ayni "organizationMember var mi"
// sorgusunu kendi icinde tekrarliyordu - gorunurluk/GUEST kuralini tek
// yerden uygulamak icin hepsi buraya yonlendirildi (bkz. proje kartinin
// kendi notu: "bu is her checkAccess fonksiyonuna dokunuyor").
//
// Kural:
//   Sahibi           -> her zaman gorur.
//   GUEST rolu       -> gorunurlukten BAGIMSIZ, ProjectMember'a eklenmis
//                       olmak ZORUNDA. GUEST'in butun anlami bu.
//   ORG gorunurluk   -> ADMIN/MEMBER herkes gorur (mevcut/varsayilan davranis).
//   TEAM gorunurluk  -> ADMIN otomatik gorur, MEMBER icin ProjectMember sart.
//   PRIVATE gorunurluk -> ADMIN dahil herkes icin ProjectMember (ya da
//                       sahiplik) sart - "private" adminin bile goremeyecegi
//                       kadar kisisel bir proje anlamina gelir.
export async function checkProjectAccess(projectId: string, userId: string): Promise<ProjectAccess> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true, ownerId: true, visibility: true },
  });
  if (!project) throw new NotFoundError("Proje");

  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: project.organizationId, userId } },
  });
  if (!member) throw new ForbiddenError("Bu projeye erişim yetkiniz yok");

  const isOwner = project.ownerId === userId;
  const allowed = isOwner || (await hasExplicitOrImplicitAccess(projectId, userId, member.role, project.visibility));
  if (!allowed) throw new ForbiddenError("Bu projeye erişim yetkiniz yok");

  return {
    role: member.role,
    projectId,
    organizationId: project.organizationId,
    visibility: project.visibility,
    isOwner,
  };
}

function needsExplicitMembership(role: Role, visibility: ProjectVisibility): boolean {
  return role === "GUEST" || visibility === "PRIVATE" || (visibility === "TEAM" && role !== "ADMIN");
}

async function hasExplicitOrImplicitAccess(
  projectId: string,
  userId: string,
  role: Role,
  visibility: ProjectVisibility,
): Promise<boolean> {
  if (!needsExplicitMembership(role, visibility)) return true; // ORG (ADMIN/MEMBER) ya da TEAM+ADMIN

  const explicit = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  return !!explicit;
}

// Liste uclarinda (GET /organizations/:id/projects gibi) tek tek
// checkProjectAccess cagirmak N+1 sorgu demek. Bunun yerine: gorunmesi
// icin ACIKCA eklenmis olmasi gereken projelerin kimliklerini TEK sorguda
// cekip bellekte filtrelıyoruz.
export async function filterVisibleProjects<
  T extends { id: string; ownerId: string; visibility: ProjectVisibility },
>(projects: T[], userId: string, role: Role): Promise<T[]> {
  const candidateIds = projects
    .filter((p) => p.ownerId !== userId && needsExplicitMembership(role, p.visibility))
    .map((p) => p.id);

  if (candidateIds.length === 0) {
    return projects.filter((p) => p.ownerId === userId || !needsExplicitMembership(role, p.visibility));
  }

  const explicitMemberships = await prisma.projectMember.findMany({
    where: { userId, projectId: { in: candidateIds } },
    select: { projectId: true },
  });
  const explicitIds = new Set(explicitMemberships.map((m) => m.projectId));

  return projects.filter(
    (p) => p.ownerId === userId || !needsExplicitMembership(role, p.visibility) || explicitIds.has(p.id),
  );
}

// Org-genelinde arama gibi UCLARIN, tek tek checkProjectAccess cagirmadan
// once "hangi projelerde arayabilirim" sorusuna toplu cevap almasi icin.
// GUEST/TEAM/PRIVATE kurallarini filterVisibleProjects ile ayni sekilde
// uygular - iki yerde ayri kural olusmasin diye ustune insa eder.
export async function getVisibleProjectIds(organizationId: string, userId: string): Promise<Set<string>> {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true },
  });
  if (!member) return new Set();

  const projects = await prisma.project.findMany({
    where: { organizationId },
    select: { id: true, ownerId: true, visibility: true },
  });
  const visible = await filterVisibleProjects(projects, userId, member.role);
  return new Set(visible.map((p) => p.id));
}

// filterVisibleProjects'in TERSI yonu: "bu kullanici hangi projeleri gorur"
// degil, "bu projeyi hangi kullanicilar gorur". Proje ADINI iceren org-geneli
// bildirim/socket yayinlarinin alici kumesini daraltmak icin gerekli - aksi
// halde PRIVATE bir projenin adi, o projeyi hic goremeyecek uyelere
// (GUEST'ler dahil) "olusturuldu/silindi" bildirimiyle sizar. Kural ikinci
// bir yerde yeniden yazilmasin diye needsExplicitMembership'in ustune kurulu.
export async function getProjectAudience(projectId: string): Promise<string[]> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true, ownerId: true, visibility: true },
  });
  if (!project) return [];

  const [members, explicitMembers] = await Promise.all([
    prisma.organizationMember.findMany({
      where: { organizationId: project.organizationId },
      select: { userId: true, role: true },
    }),
    prisma.projectMember.findMany({ where: { projectId }, select: { userId: true } }),
  ]);
  const explicitIds = new Set(explicitMembers.map((m) => m.userId));

  return members
    .filter(
      (m) =>
        m.userId === project.ownerId ||
        !needsExplicitMembership(m.role, project.visibility) ||
        explicitIds.has(m.userId),
    )
    .map((m) => m.userId);
}

export async function checkColumnAccess(columnId: string, userId: string) {
  const column = await prisma.column.findUnique({
    where: { id: columnId },
    select: { name: true, projectId: true },
  });
  if (!column) throw new NotFoundError("Sütun");

  const access = await checkProjectAccess(column.projectId, userId);
  return { ...access, columnName: column.name };
}

export async function checkCardAccess(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { title: true, columnId: true, column: { select: { projectId: true } } },
  });
  if (!card) throw new NotFoundError("Kart");

  const access = await checkProjectAccess(card.column.projectId, userId);
  return { ...access, columnId: card.columnId, cardTitle: card.title };
}

// Proje ayarlarini (gorunurluk, davetli listesi) sadece proje sahibi ya da
// org ADMIN'i degistirebilir - PRIVATE bir projeyi "TEAM"e cevirip erisim
// acmak yapisal bir degisiklik, sahiplik/adminlik gerektirir.
export function assertCanManageProjectAccess(access: ProjectAccess) {
  if (!access.isOwner && access.role !== "ADMIN") {
    throw new ForbiddenError("Proje erişim ayarlarını sadece proje sahibi veya org admini değiştirebilir");
  }
}
