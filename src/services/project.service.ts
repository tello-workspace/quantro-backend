import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import * as notificationService from "@/services/notification.service";
import { broadcastToOrganization, SocketEvents } from "@/server/socket";
import type { CreateProjectInput, UpdateProjectInput } from "@/schemas/project.schema";

// Organization üyeliğini kontrol et
async function checkMembership(organizationId: string, userId: string) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  return member;
}

// ADMIN mi kontrol et
async function checkAdmin(organizationId: string, userId: string) {
  const member = await checkMembership(organizationId, userId);
  return member?.role === "ADMIN";
}

export async function createProject(organizationId: string, input: CreateProjectInput, userId: string) {
  const member = await checkMembership(organizationId, userId);
  if (!member) throw new ForbiddenError("Bu organizasyonda proje oluşturma yetkiniz yok");

  const project = await prisma.project.create({
    data: {
      name: input.name,
      description: input.description,
      organizationId,
      ownerId: userId,
      columns: {
        create: [
          { name: "To Do", position: 1 },
          { name: "In Progress", position: 2 },
          { name: "Done", position: 3, isDone: true },
        ],
      },
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
  const member = await checkMembership(organizationId, userId);
  if (!member) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");

  const projects = await prisma.project.findMany({
    where: { organizationId },
    include: {
      _count: { select: { columns: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return projects;
}

export async function getProjectById(organizationId: string, projectId: string, userId: string) {
  const member = await checkMembership(organizationId, userId);
  if (!member) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");

  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId },
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

  broadcastToOrganization(organizationId, SocketEvents.PROJECT_DELETED, {
    projectId: project.id,
    projectName: project.name,
  });

  await prisma.project.delete({ where: { id: projectId } });

  broadcastToOrganization(organizationId, SocketEvents.PROJECT_DELETED, {
    projectId,
    projectName: project.name,
  });
}
