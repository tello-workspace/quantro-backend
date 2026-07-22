import { prisma } from "@/lib/prisma";
import { NotFoundError, ConflictError, ForbiddenError } from "@/utils/errors";
import * as notificationService from "@/services/notification.service";
import { broadcastToOrganization, SocketEvents } from "@/server/socket";
import type { CreateOrganizationInput, UpdateOrganizationInput, AddMemberInput, UpdateMemberRoleInput } from "@/schemas/organization.schema";
import type { Role } from "@prisma/client";

// Kullanıcının bir organizasyonda üye olup olmadığını kontrol et
async function checkMembership(organizationId: string, userId: string) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  return member;
}

// Kullanıcının ADMIN olup olmadığını kontrol et
async function checkAdmin(organizationId: string, userId: string) {
  const member = await checkMembership(organizationId, userId);
  return member?.role === "ADMIN";
}

// --- CRUD ---

export async function createOrganization(input: CreateOrganizationInput, userId: string) {
  const org = await prisma.organization.create({
    data: {
      name: input.name,
      description: input.description,
      ownerId: userId,
      members: {
        create: { userId, role: "ADMIN" },
      },
    },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, email: true } } },
      },
    },
  });

  return org;
}

export async function getMyOrganizations(userId: string) {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId },
    include: {
      organization: {
        include: {
          _count: { select: { members: true, projects: true } },
        },
      },
    },
    orderBy: { joinedAt: "desc" },
  });

  return memberships.map((m) => ({
    ...m.organization,
    role: m.role,
    memberCount: m.organization._count.members,
    projectCount: m.organization._count.projects,
  }));
}

export async function getOrganizationById(organizationId: string, userId: string) {
  const member = await checkMembership(organizationId, userId);
  if (!member) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, email: true } } },
      },
      projects: {
        select: { id: true, name: true, description: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!org) throw new NotFoundError("Organizasyon");

  return { ...org, myRole: member.role };
}

export async function updateOrganization(organizationId: string, input: UpdateOrganizationInput, userId: string) {
  const isAdmin = await checkAdmin(organizationId, userId);
  if (!isAdmin) throw new ForbiddenError("Sadece adminler organizasyonu düzenleyebilir");

  const org = await prisma.organization.update({
    where: { id: organizationId },
    data: input,
  });

  return org;
}

export async function deleteOrganization(organizationId: string, userId: string) {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw new NotFoundError("Organizasyon");
  if (org.ownerId !== userId) throw new ForbiddenError("Sadece kurucu organizasyonu silebilir");

  await prisma.organization.delete({ where: { id: organizationId } });
}

// --- DAVET SISTEMI ---
// "Davet et" artik aninda uye yapmiyor: PENDING bir davet olusturuyor,
// karsi taraf bildirimden kabul/reddet secene kadar uye olmuyor.

export async function inviteMember(organizationId: string, input: AddMemberInput, userId: string) {
  const isAdmin = await checkAdmin(organizationId, userId);
  if (!isAdmin) throw new ForbiddenError("Sadece adminler davet gönderebilir");

  const invitedUser = await prisma.user.findUnique({ where: { email: input.email } });
  if (!invitedUser) throw new NotFoundError("Bu email ile kayıtlı kullanıcı bulunamadı");

  const existingMembership = await checkMembership(organizationId, invitedUser.id);
  if (existingMembership) throw new ConflictError("Bu kullanıcı zaten organizasyon üyesi");

  const existingInvite = await prisma.organizationInvitation.findFirst({
    where: { organizationId, invitedUserId: invitedUser.id, status: "PENDING" },
  });
  if (existingInvite) throw new ConflictError("Bu kullanıcıya zaten bekleyen bir davet var");

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw new NotFoundError("Organizasyon");

  const invitation = await prisma.organizationInvitation.create({
    data: {
      organizationId,
      invitedUserId: invitedUser.id,
      invitedById: userId,
      role: (input.role ?? "MEMBER") as Role,
    },
  });

  const inviter = await prisma.user.findUnique({ where: { id: userId } });

  await notificationService.createNotification({
    userId: invitedUser.id,
    type: "ORG_INVITE",
    message: `${inviter?.name ?? "Bir kullanıcı"} sizi "${org.name}" organizasyonuna davet etti`,
    invitationId: invitation.id,
  });

  return invitation;
}

export async function getMyInvitations(userId: string) {
  const invitations = await prisma.organizationInvitation.findMany({
    where: { invitedUserId: userId, status: "PENDING" },
    include: {
      organization: { select: { id: true, name: true } },
      invitedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return invitations;
}

export async function acceptInvitation(invitationId: string, userId: string) {
  const invitation = await prisma.organizationInvitation.findUnique({
    where: { id: invitationId },
    include: { organization: true },
  });
  if (!invitation) throw new NotFoundError("Davet");
  if (invitation.invitedUserId !== userId) throw new ForbiddenError("Bu davet size ait değil");
  if (invitation.status !== "PENDING") throw new ConflictError("Bu davet zaten yanıtlanmış");

  const member = await prisma.$transaction(async (tx) => {
    const created = await tx.organizationMember.create({
      data: {
        organizationId: invitation.organizationId,
        userId,
        role: invitation.role,
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    await tx.organizationInvitation.update({
      where: { id: invitationId },
      data: { status: "ACCEPTED", respondedAt: new Date() },
    });

    return created;
  });

  await notificationService.createNotification({
    userId: invitation.invitedById,
    type: "ORG_JOINED",
    message: `${member.user.name}, "${invitation.organization.name}" davetini kabul etti`,
  });

  broadcastToOrganization(invitation.organizationId, SocketEvents.ORG_MEMBER_ADDED, {
    organizationId: invitation.organizationId,
    userId: member.userId,
    userName: member.user.name,
    role: member.role,
  });

  return member;
}

// Organizasyonun henuz yanitlanmamis davetlerini goster - admin kime davet
// gonderdigini ve hala bekledigini takip edebilsin
export async function getPendingInvitations(organizationId: string, userId: string) {
  const isAdmin = await checkAdmin(organizationId, userId);
  if (!isAdmin) throw new ForbiddenError("Sadece adminler bekleyen davetleri görebilir");

  return prisma.organizationInvitation.findMany({
    where: { organizationId, status: "PENDING" },
    include: {
      invitedUser: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

// Yanlislikla ya da yanlis email'e gonderilen bekleyen daveti geri al -
// silinince iliskili ORG_INVITE bildirimi de cascade ile kalkar
export async function cancelInvitation(organizationId: string, invitationId: string, userId: string) {
  const isAdmin = await checkAdmin(organizationId, userId);
  if (!isAdmin) throw new ForbiddenError("Sadece adminler daveti geri alabilir");

  const invitation = await prisma.organizationInvitation.findUnique({ where: { id: invitationId } });
  if (!invitation || invitation.organizationId !== organizationId) throw new NotFoundError("Davet");
  if (invitation.status !== "PENDING") throw new ConflictError("Bu davet zaten yanıtlanmış");

  await prisma.organizationInvitation.delete({ where: { id: invitationId } });

  return { cancelled: true };
}

export async function declineInvitation(invitationId: string, userId: string) {
  const invitation = await prisma.organizationInvitation.findUnique({ where: { id: invitationId } });
  if (!invitation) throw new NotFoundError("Davet");
  if (invitation.invitedUserId !== userId) throw new ForbiddenError("Bu davet size ait değil");
  if (invitation.status !== "PENDING") throw new ConflictError("Bu davet zaten yanıtlanmış");

  await prisma.organizationInvitation.update({
    where: { id: invitationId },
    data: { status: "DECLINED", respondedAt: new Date() },
  });

  return { declined: true };
}

// --- ÜYE YÖNETİMİ ---

export async function removeMember(organizationId: string, memberUserId: string, userId: string) {
  const isAdmin = await checkAdmin(organizationId, userId);
  if (!isAdmin) throw new ForbiddenError("Sadece adminler üye çıkarabilir");

  // Kurucu çıkarılamaz
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (org?.ownerId === memberUserId) throw new ForbiddenError("Kurucu organizasyondan çıkarılamaz");

  const member = await checkMembership(organizationId, memberUserId);
  if (!member) throw new NotFoundError("Üye");

  // Bildirimi silme işlemi öncesinde gönder
  await notificationService.createNotification({
    userId: memberUserId,
    type: "ORG_REMOVED",
    message: `"${org?.name ?? "Organizasyon"}" organizasyonundan çıkarıldınız`,
  });

  await prisma.organizationMember.delete({
    where: { organizationId_userId: { organizationId, userId: memberUserId } },
  });

  broadcastToOrganization(organizationId, SocketEvents.ORG_MEMBER_REMOVED, {
    organizationId,
    userId: memberUserId,
    userName: member.user.name,
  });
}

export async function updateMemberRole(organizationId: string, input: UpdateMemberRoleInput, userId: string) {
  const isAdmin = await checkAdmin(organizationId, userId);
  if (!isAdmin) throw new ForbiddenError("Sadece adminler rol değiştirebilir");

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw new NotFoundError("Organizasyon");

  if (org.ownerId === input.userId) {
    throw new ForbiddenError("Kurucunun rolü değiştirilemez");
  }

  const member = await checkMembership(organizationId, input.userId);
  if (!member) throw new NotFoundError("Üye");

  const updated = await prisma.organizationMember.update({
    where: { organizationId_userId: { organizationId, userId: input.userId } },
    data: { role: input.role as Role },
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
  });

  // Sadece admin yapılınca bildirim git
  if (input.role === "ADMIN") {
    await notificationService.createNotification({
      userId: input.userId,
      type: "ROLE_CHANGED",
      message: `"${org.name}" organizasyonunda yönetici yapıldınız`,
    });
  }

  broadcastToOrganization(organizationId, SocketEvents.ORG_MEMBER_ROLE_CHANGED, {
    organizationId,
    userId: input.userId,
    userName: updated.user.name,
    role: input.role,
  });

  return updated;
}
