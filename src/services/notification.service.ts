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

// Sabit take:50 sayfalama olmadan kullanildigi icin 50'den eski bildirimlere
// hicbir sekilde ulasilamiyordu; getUnreadCount ise sinirsiz saydigi icin zil
// rozeti ile liste kalici olarak tutarsiz kaliyordu. Cursor (son goruntulenen
// bildirim id'si) ve limit parametreleri bu boslugu kapatir. Donen deger yine
// duz bir dizi; istemci bir sonraki sayfa icin son ogenin id'sini cursor olarak
// yollar. Ikincil id siralamasi ayni milisaniyeli kayitlarda sayfa kaymasini onler.
export async function getNotifications(
  userId: string,
  unreadOnly?: boolean,
  options?: { limit?: number; cursor?: string },
) {
  const where: Record<string, unknown> = { userId };
  if (unreadOnly) where.read = false;

  const take = options?.limit ?? 50;

  const notifications = await prisma.notification.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    // cursor verilen kayit onceki sayfanin son ogesi oldugu icin skip:1 ile atlanir
    ...(options?.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
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
  // Mesaj org GENELINE degil belirli bir alici kumesine gitmeliyse (orn.
  // gorunurlugu kisitli bir projenin ADINI iceren bildirimler) cagiran
  // taraf alici listesini verir; verilmezse eski davranis (tum uyeler).
  onlyUserIds?: string[],
) {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId },
    select: { userId: true },
  });

  const izinliSet = onlyUserIds ? new Set(onlyUserIds) : null;
  const filtered = members.filter(
    (m) => m.userId !== excludeUserId && (izinliSet === null || izinliSet.has(m.userId)),
  );

  if (filtered.length === 0) return;

  // Sessize alma: bu tipi kapatmis uyeler toplu bildirimden cikarilir.
  const muted = await prisma.userNotificationPref.findMany({
    where: { enabled: false, type, userId: { in: filtered.map((m) => m.userId) } },
    select: { userId: true },
  });
  const mutedSet = new Set(muted.map((m) => m.userId));
  const recipients = filtered.filter((m) => !mutedSet.has(m.userId));

  if (recipients.length === 0) return;

  // createMany olusturulan id'leri dondurmedigi icin socket payload'i id'siz
  // kaliyordu; istemci NOTIFICATION_READ'i notificationId olmadan gonderemedigi
  // (ve React listesinde ayni undefined anahtari kullandigi) icin gercek
  // satirlari donduren createManyAndReturn kullaniliyor.
  const created = await prisma.notification.createManyAndReturn({
    data: recipients.map((m) => ({
      userId: m.userId,
      type,
      message,
    })),
    select: { id: true, userId: true, read: true, createdAt: true },
  });

  for (const notification of created) {
    broadcastToUser(notification.userId, SocketEvents.NOTIFICATION_NEW, {
      id: notification.id,
      userId: notification.userId,
      type,
      message,
      read: notification.read,
      createdAt: notification.createdAt.toISOString(),
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
