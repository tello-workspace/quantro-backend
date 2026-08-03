import { prisma } from "@/lib/prisma";
import { broadcastToUser, SocketEvents } from "@/server/socket";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import type { NotificationType } from "@prisma/client";

interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  message: string;
  cardId?: string;
  invitationId?: string;
}

// Kullanici bu bildirim tipini sessize aldiysa true doner. Alinan
// pref satiri enabled=false tutar (varsayilan: her tip acik, satir yok).
async function isTypeMuted(userId: string, type: NotificationType): Promise<boolean> {
  const pref = await prisma.userNotificationPref.findUnique({
    where: { userId_type: { userId, type } },
    select: { enabled: true },
  });
  return pref !== null && pref.enabled === false;
}

export async function createNotification(input: CreateNotificationInput) {
  // Sessize alma: kapali bir tip icin bildirim OLUSTURULMAZ (skip-creation).
  // Boylece DB satiri ve socket event'i gereksiz uretilmez.
  if (await isTypeMuted(input.userId, input.type)) return null;

  const notification = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      message: input.message,
      cardId: input.cardId,
      invitationId: input.invitationId,
    },
    include: {
      card: {
        select: {
          id: true,
          title: true,
          column: {
            select: {
              projectId: true,
              project: { select: { organizationId: true } },
            },
          },
        },
      },
      invitation: { select: { id: true, status: true } },
    },
  });

  broadcastToUser(input.userId, SocketEvents.NOTIFICATION_NEW, {
    ...notification,
    card: notification.card ?? undefined,
    read: notification.read,
    createdAt: notification.createdAt.toISOString(),
  });

  return notification;
}

export async function getNotifications(userId: string, unreadOnly?: boolean) {
  const where: Record<string, unknown> = { userId };
  if (unreadOnly) where.read = false;

  const notifications = await prisma.notification.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      card: {
        select: {
          id: true,
          title: true,
          column: {
            select: {
              projectId: true,
              project: { select: { organizationId: true } },
            },
          },
        },
      },
      invitation: { select: { id: true, status: true } },
    },
  });

  return notifications;
}

export async function getUnreadCount(userId: string) {
  const count = await prisma.notification.count({
    where: { userId, read: false },
  });

  return count;
}

export async function markAsRead(notificationId: string, userId: string) {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });

  if (!notification) throw new NotFoundError("Bildirim");
  if (notification.userId !== userId) throw new ForbiddenError("Bu bildirimi okuma yetkiniz yok");

  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { read: true },
  });

  broadcastToUser(userId, SocketEvents.NOTIFICATION_READ, { notificationId, read: true });

  return updated;
}

export async function markAllAsRead(userId: string) {
  await prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });

  broadcastToUser(userId, SocketEvents.NOTIFICATION_ALL_READ, { success: true });

  return { success: true };
}

export async function broadcastToOrganization(
  organizationId: string,
  type: NotificationType,
  message: string,
  excludeUserId?: string,
) {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId },
    select: { userId: true },
  });

  const filtered = excludeUserId
    ? members.filter((m) => m.userId !== excludeUserId)
    : members;

  if (filtered.length === 0) return;

  // Sessize alma: bu tipi kapatmis uyeler toplu bildirimden cikarilir.
  const muted = await prisma.userNotificationPref.findMany({
    where: { enabled: false, type, userId: { in: filtered.map((m) => m.userId) } },
    select: { userId: true },
  });
  const mutedSet = new Set(muted.map((m) => m.userId));
  const recipients = filtered.filter((m) => !mutedSet.has(m.userId));

  if (recipients.length === 0) return;

  await prisma.notification.createMany({
    data: recipients.map((m) => ({
      userId: m.userId,
      type,
      message,
    })),
  });

  const createdAt = new Date().toISOString();
  for (const member of recipients) {
    broadcastToUser(member.userId, SocketEvents.NOTIFICATION_NEW, {
      userId: member.userId,
      type,
      message,
      read: false,
      createdAt,
    });
  }
}

// Kullanicinin mevcut bildirim tercihlerini getirir (kapali tipler).
export async function getNotificationPrefs(userId: string) {
  const prefs = await prisma.userNotificationPref.findMany({
    where: { userId },
    select: { type: true, enabled: true },
  });
  return prefs;
}

// Bildirim tercihini gunceller (sessize al / act). enabled=true ise satir
// silinir (varsayilan: acik), false ise upsert edilir.
export async function setNotificationPref(
  userId: string,
  type: NotificationType,
  enabled: boolean,
) {
  if (enabled) {
    await prisma.userNotificationPref.deleteMany({ where: { userId, type } });
  } else {
    await prisma.userNotificationPref.upsert({
      where: { userId_type: { userId, type } },
      create: { userId, type, enabled: false },
      update: { enabled: false },
    });
  }
  return { type, enabled };
}
