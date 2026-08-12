import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import * as notificationService from "@/services/notification.service";
import { broadcastToOrganization, SocketEvents } from "@/server/socket";
import {
  findAvailableProjectKey,
  normalizeProjectKey,
  suggestProjectKey,
} from "@/services/card-key.service";
import { checkProjectAccess, filterVisibleProjects, assertCanManageProjectAccess } from "@/services/access-control.service";
import { resolveTemplate } from "@/services/project-template.service";
import type { CreateProjectInput, UpdateProjectInput } from "@/schemas/project.schema";
import type { ProjectVisibility } from "@prisma/client";

// Organization üyeliğini kontrol et
export async function checkMembership(organizationId: string, userId: string) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  return member;
}

export async function createProject(organizationId: string, input: CreateProjectInput, userId: string) {
  const member = await checkMembership(organizationId, userId);
  if (!member) throw new ForbiddenError("Bu organizasyonda proje oluşturma yetkiniz yok");
  // Yapisal degisiklik: uye dogrudan yapamaz, talep acar
  if (member.role !== "ADMIN") {
    throw new ForbiddenError(
      "Projeyi sadece adminler oluşturabilir. Proje talebi gönderebilirsiniz.",
    );
  }

  // Kart anahtarı öneki: kullanıcı verdiyse doğrula, vermediyse addan üret.
  // Her iki durumda da org içinde boş olan ilk anahtara düşülüyor - anahtar
  // çakışması yüzünden proje oluşturmayı reddetmek kullanıcıya hiçbir şey
  // kazandırmaz, "QNT doluydu, QNT2 verdim" demek yeterli.
  const istenenKey = input.key
    ? normalizeProjectKey(input.key)
    : suggestProjectKey(input.name);
  const key = await findAvailableProjectKey(organizationId, istenenKey);

  // Sablon secilmemisse eski sabit 4 kolona dus - mevcut davranis degismiyor.
  const sablon = await resolveTemplate(input.templateId, organizationId);
  const kolonlar = sablon?.columns ?? [
    { name: "To Do", position: 1 },
    { name: "In Progress", position: 2 },
    { name: "Testing", position: 3 },
    { name: "Done", position: 4, isDone: true },
  ];

  const project = await prisma.project.create({
    data: {
      name: input.name,
      description: input.description,
      key,
      organizationId,
      ownerId: userId,
      columns: { create: kolonlar },
      labels: sablon?.labels && sablon.labels.length > 0 ? { create: sablon.labels } : undefined,
    },
    include: {
      columns: { orderBy: { position: "asc" } },
    },
  });

  await notificationService.broadcastToOrganization(
    organizationId,
    "PROJECT_CREATED",
    `"${project.name}" projesi oluşturuldu`,
    userId, // yapan hariç
  );

  // Emit real-time event
  broadcastToOrganization(organizationId, SocketEvents.PROJECT_CREATED, {
    id: project.id,
    name: project.name,
    description: project.description,
    organizationId,
    ownerId: userId,
  });

  return project;
}

export async function getProjects(organizationId: string, userId: string) {
  // Uyelik kontrolu ile liste sorgusu bagimsiz; paralel calisip bir
  // gidis-donus kazandiriyorlar. Yetki yoksa veri donmeden hata firlatilir.
  const [member, projects] = await Promise.all([
    checkMembership(organizationId, userId),
    prisma.project.findMany({
      where: { organizationId },
      include: {
        _count: { select: { columns: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  if (!member) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");

  // GUEST'ler ve TEAM/PRIVATE gorunurluklu projeler icin acikca eklenmemis
  // uyeler listede o projeyi hic gormemeli - aksi halde "sadece tek projeyi
  // gorsun" davetinin anlami kalmaz (kart adi kendi kendine gorunur).
  return filterVisibleProjects(projects, userId, member.role);
}

export async function getProjectById(organizationId: string, projectId: string, userId: string) {
  // checkProjectAccess org uyeligini VE proje gorunurluk/GUEST kuralini
  // birlikte kontrol ediyor - checkMembership'in eskiden tek basina yaptigi
  // (sadece org uyeligi) burada yetersizdi.
  const access = await checkProjectAccess(projectId, userId);
  if (access.organizationId !== organizationId) throw new NotFoundError("Proje");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      columns: {
        orderBy: { position: "asc" },
        include: {
          _count: { select: { cards: true } },
        },
      },
      _count: { select: { columns: true } },
    },
  });
  if (!project) throw new NotFoundError("Proje");

  return project;
}

export async function listProjectMembers(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  return prisma.projectMember.findMany({
    where: { projectId },
    orderBy: { addedAt: "asc" },
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
  });
}

export async function updateProjectVisibility(projectId: string, visibility: ProjectVisibility, userId: string) {
  const access = await checkProjectAccess(projectId, userId);
  assertCanManageProjectAccess(access);

  const updated = await prisma.project.update({ where: { id: projectId }, data: { visibility } });

  broadcastToOrganization(access.organizationId, SocketEvents.PROJECT_UPDATED, {
    id: updated.id,
    name: updated.name,
    description: updated.description,
    organizationId: access.organizationId,
    ownerId: updated.ownerId,
  });

  return updated;
}

// targetUserId ayni organizasyonun uyesi olmak zorunda - baska bir org'dan
// birini bir projeye eklemek GUEST/gorunurluk mekanizmasinin tamamen
// disinda, ayri (ve cok daha buyuk) bir "cok-organizasyonlu proje" ozelligi
// olurdu.
export async function addProjectMember(projectId: string, targetUserId: string, userId: string) {
  const access = await checkProjectAccess(projectId, userId);
  assertCanManageProjectAccess(access);

  const targetMember = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: access.organizationId, userId: targetUserId } },
  });
  if (!targetMember) throw new ForbiddenError("Kullanıcı bu organizasyonun üyesi değil");

  return prisma.projectMember.upsert({
    where: { projectId_userId: { projectId, userId: targetUserId } },
    create: { projectId, userId: targetUserId },
    update: {},
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
  });
}

export async function removeProjectMember(projectId: string, targetUserId: string, userId: string) {
  const access = await checkProjectAccess(projectId, userId);
  assertCanManageProjectAccess(access);

  await prisma.projectMember.deleteMany({ where: { projectId, userId: targetUserId } });
}

export async function updateProject(organizationId: string, projectId: string, input: UpdateProjectInput, userId: string) {
  const member = await checkMembership(organizationId, userId);
  if (!member) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");

  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId },
  });
  if (!project) throw new NotFoundError("Proje");

  // Proje sahibi veya org admini güncelleyebilir
  if (project.ownerId !== userId && member.role !== "ADMIN") {
    throw new ForbiddenError("Sadece proje sahibi veya org admini düzenleyebilir");
  }

  const updated = await prisma.project.update({
    where: { id: projectId },
    data: input,
  });

  // Emit real-time event
  broadcastToOrganization(organizationId, SocketEvents.PROJECT_UPDATED, {
    id: updated.id,
    name: updated.name,
    description: updated.description,
    organizationId,
    ownerId: updated.ownerId,
  });

  return updated;
}

export async function deleteProject(organizationId: string, projectId: string, userId: string) {
  const member = await checkMembership(organizationId, userId);
  if (!member) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");

  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId },
  });
  if (!project) throw new NotFoundError("Proje");

  // Proje sahibi veya org admini silebilir
  if (project.ownerId !== userId && member.role !== "ADMIN") {
    throw new ForbiddenError("Sadece proje sahibi veya org admini silebilir");
  }

  await notificationService.broadcastToOrganization(
    organizationId,
    "PROJECT_DELETED",
    `"${project.name}" projesi silindi`,
    userId, // yapan hariç
  );

  // Emit real-time event
  broadcastToOrganization(organizationId, SocketEvents.PROJECT_DELETED, {
    projectId,
    projectName: project.name,
  });

  await prisma.project.delete({ where: { id: projectId } });
}
