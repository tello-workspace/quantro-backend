import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ConflictError } from "@/utils/errors";
import type { CreateBadgeInput } from "@/schemas/organization.schema";

// Admin yetki kontrolu — organizasyon bazinda
async function checkAdmin(organizationId: string, userId: string) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true },
  });
  if (!member) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");
  if (member.role !== "ADMIN") throw new ForbiddenError("Bu işlem için admin yetkisi gerekli");
}

// --- CRUD ---

export async function listBadges(organizationId: string, userId: string) {
  // Uyelik kontrolu: org uyesi olmayan erisemesin
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true },
  });
  if (!member) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");

  const badges = await prisma.badge.findMany({
    where: { organizationId },
    include: {
      users: {
        include: { user: { select: { id: true, name: true } } },
      },
    },
    orderBy: { name: "asc" },
  });

  return badges.map((b) => ({
    id: b.id,
    name: b.name,
    color: b.color,
    icon: b.icon,
    createdAt: b.createdAt,
    assignedUsers: b.users.map((u) => u.user),
  }));
}

export async function createBadge(organizationId: string, input: CreateBadgeInput, userId: string) {
  await checkAdmin(organizationId, userId);

  // Ayni isimde rozet var mi?
  const existing = await prisma.badge.findUnique({
    where: { organizationId_name: { organizationId, name: input.name } },
  });
  if (existing) throw new ConflictError(`"${input.name}" rozeti zaten mevcut`);

  const badge = await prisma.badge.create({
    data: {
      organizationId,
      name: input.name,
      color: input.color,
      icon: input.icon ?? null,
    },
  });

  return badge;
}

export async function deleteBadge(organizationId: string, badgeId: string, userId: string) {
  await checkAdmin(organizationId, userId);

  const badge = await prisma.badge.findUnique({
    where: { id: badgeId },
    select: { organizationId: true },
  });
  if (!badge || badge.organizationId !== organizationId) throw new NotFoundError("Rozet");

  // UserBadge'ler cascade silinir (onDelete: Cascade)
  await prisma.badge.delete({ where: { id: badgeId } });

  return { deleted: true };
}

// --- Atama Yonetimi ---

export async function assignBadge(organizationId: string, badgeId: string, targetUserId: string, userId: string) {
  await checkAdmin(organizationId, userId);

  // Rozet bu org'a ait mi?
  const badge = await prisma.badge.findUnique({
    where: { id: badgeId },
    select: { organizationId: true, name: true },
  });
  if (!badge || badge.organizationId !== organizationId) throw new NotFoundError("Rozet");

  // Hedef kullanici org uyesi mi?
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: targetUserId } },
  });
  if (!member) throw new NotFoundError("Kullanıcı bu organizasyonun üyesi değil");

  // Zaten atanmis mi?
  const existing = await prisma.userBadge.findUnique({
    where: { userId_badgeId: { userId: targetUserId, badgeId } },
  });
  if (existing) throw new ConflictError("Bu kullanıcı zaten bu rozete sahip");

  await prisma.userBadge.create({
    data: { userId: targetUserId, badgeId },
  });

  return { assigned: true, badgeName: badge.name };
}

export async function removeBadge(organizationId: string, badgeId: string, targetUserId: string, userId: string) {
  await checkAdmin(organizationId, userId);

  // Rozet bu org'a ait mi?
  const badge = await prisma.badge.findUnique({
    where: { id: badgeId },
    select: { organizationId: true },
  });
  if (!badge || badge.organizationId !== organizationId) throw new NotFoundError("Rozet");

  const rel = await prisma.userBadge.findUnique({
    where: { userId_badgeId: { userId: targetUserId, badgeId } },
  });
  if (!rel) throw new NotFoundError("Bu kullanıcıda bu rozet bulunamadı");

  await prisma.userBadge.delete({
    where: { userId_badgeId: { userId: targetUserId, badgeId } },
  });

  return { removed: true };
}
