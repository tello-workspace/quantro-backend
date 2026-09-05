import { prisma } from "@/lib/prisma";
import { checkCardAccess } from "@/services/access-control.service";
import { broadcastToUser, SocketEvents } from "@/server/socket";

export async function getWatchStatus(cardId: string, userId: string) {
  await checkCardAccess(cardId, userId);

  const [isWatching, watcherCount] = await Promise.all([
    prisma.cardWatcher.findUnique({ where: { cardId_userId: { cardId, userId } } }).then((w) => !!w),
    prisma.cardWatcher.count({ where: { cardId } }),
  ]);

  return { isWatching, watcherCount };
}

export async function watchCard(cardId: string, userId: string) {
  await checkCardAccess(cardId, userId);

  await prisma.cardWatcher.upsert({
    where: { cardId_userId: { cardId, userId } },
    create: { cardId, userId },
    update: {},
  });

  return getWatchStatus(cardId, userId);
}

export async function unwatchCard(cardId: string, userId: string) {
  await checkCardAccess(cardId, userId);

  await prisma.cardWatcher.deleteMany({ where: { cardId, userId } });

  return getWatchStatus(cardId, userId);
}

/**
 * Birden fazla kartı tek seferde izlemeye alır / izlemeden çıkarır.
 *
 * Yetki kontrolü kart başına DEĞİL, kartların ait olduğu organizasyonlar
 * üzerinden TEK sorguda yapılıyor: bulk-card.service.ts'te ögrendigimiz ders
 * burada da geçerli - N kart için N yetki sorgusu açmak Supabase oturum
 * havuzunu (pool_size 15) tüketiyor.
 *
 * Erişilemeyen kartlar sessizce atlanmaz, sonuçta `atlanan` olarak döner.
 */
export async function toggleWatchMany(
  cardIds: string[],
  userId: string,
  izle: boolean,
): Promise<{ islenen: string[]; atlanan: string[] }> {
  if (cardIds.length === 0) return { islenen: [], atlanan: [] };

  const kartlar = await prisma.card.findMany({
    where: { id: { in: cardIds } },
    select: {
      id: true,
      column: { select: { project: { select: { organizationId: true } } } },
    },
  });

  const orgIdleri = Array.from(new Set(kartlar.map((k) => k.column.project.organizationId)));
  const uyelikler = await prisma.organizationMember.findMany({
    where: { userId, organizationId: { in: orgIdleri } },
    select: { organizationId: true },
  });
  const uyeOlunanlar = new Set(uyelikler.map((u) => u.organizationId));

  const islenen = kartlar
    .filter((k) => uyeOlunanlar.has(k.column.project.organizationId))
    .map((k) => k.id);
  const islenenKume = new Set(islenen);
  const atlanan = cardIds.filter((id) => !islenenKume.has(id));

  if (islenen.length === 0) return { islenen, atlanan };

  if (izle) {
    // skipDuplicates: zaten izlenen kartlar hata vermesin, istek
    // "bunların hepsi izlensin" anlamına geliyor.
    await prisma.cardWatcher.createMany({
      data: islenen.map((cardId) => ({ cardId, userId })),
      skipDuplicates: true,
    });
  } else {
    await prisma.cardWatcher.deleteMany({ where: { userId, cardId: { in: islenen } } });
  }

  return { islenen, atlanan };
}

/**
 * Kullanıcının izlediği kartlar. TÜKETME TARAFI: özelliğin ilk sürümü
 * (8aed3ab, 3 gün sonra kaldırıldı) yalnızca abone olmayı sağlıyordu -
 * kullanıcı neyi izlediğini görebileceği hiçbir ekran yoktu ve özellik bu
 * yüzden kullanışsız bulundu. Bu uç dashboard'daki "İzlediklerim"i besliyor.
 *
 * Atanan kartlar listesiyle (dashboard.service) aynı şekli döndürüyor ki
 * arayüz aynı kart bileşenini ve teslim tarihi rozetlerini kullanabilsin.
 */
export async function getWatchedCards(userId: string) {
  const watched = await prisma.cardWatcher.findMany({
    where: {
      userId,
      card: {
        // Arşivlenmiş kart "izlediklerim"de görünmemeli - kullanıcı için o iş
        // bitmiş sayılır. İzleme kaydı silinmiyor: kart geri yüklenirse
        // abonelik kaldığı yerden devam etsin.
        isArchived: false,
        // ÜYELİK ŞART. İzleme kaydı organizasyondan ayrılınca silinmiyor
        // (CardWatcher karta ve kullanıcıya bağlı, üyeliğe değil). Bu filtre
        // olmadan organizasyondan çıkmış biri kart başlığını, proje adını,
        // kolonunu ve KİMLERE ATANDIĞINI görmeye devam ediyordu.
        // Filtre silme yerine tercih edildi: kişi tekrar üye olursa abonelik
        // kaldığı yerden devam etsin (arşiv davranışıyla aynı mantık).
        column: { project: { organization: { members: { some: { userId } } } } },
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      createdAt: true,
      card: {
        select: {
          id: true,
          title: true,
          description: true,
          priority: true,
          dueDate: true,
          lastActivityAt: true,
          column: {
            select: {
              id: true,
              name: true,
              isDone: true,
              project: {
                select: { id: true, name: true, organizationId: true },
              },
            },
          },
          assignees: {
            select: { user: { select: { id: true, name: true, avatarUrl: true } } },
          },
        },
      },
    },
  });

  return watched.map((w) => ({
    id: w.card.id,
    title: w.card.title,
    description: w.card.description,
    priority: w.card.priority,
    dueDate: w.card.dueDate?.toISOString() ?? null,
    lastActivityAt: w.card.lastActivityAt.toISOString(),
    watchedAt: w.createdAt.toISOString(),
    columnId: w.card.column.id,
    columnName: w.card.column.name,
    isDone: w.card.column.isDone,
    projectId: w.card.column.project.id,
    projectName: w.card.column.project.name,
    organizationId: w.card.column.project.organizationId,
    assignees: w.card.assignees.map((a) => ({
      id: a.user.id,
      name: a.user.name,
      avatarUrl: a.user.avatarUrl,
    })),
  }));
}

/**
 * Kartın izleyicilerine bir bildirim yollar.
 *
 * `excludeUserId` KENDİ eylemini yapan kişidir ve bilerek dışarıda bırakılır:
 * kendi yorumundan/taşımandan bildirim almak özelliği doğrudan gürültü
 * kaynağına çevirir.
 *
 * Atama bildirimlerinden AYRI çalışır - birisi hem atanmış hem izliyor
 * olabilir ve iki bildirimi de alır, çünkü farklı şeyler söylerler:
 * biri "sana atandı", diğeri "izlediğin kartta hareket var".
 *
 * TOPLU YAZIM: eskiden izleyici başına notificationService.createNotification
 * çağrılıyordu; bu, izleyici başına 2 seri sorgu (sessize alma kontrolü +
 * insert) demekti. 40 izleyicili bir kartta tek yorum 80 ardışık sorgu açıp
 * Supabase oturum havuzunu (pool_size 15) tıkıyordu - toggleWatchMany'de
 * kaçınılan hatanın aynısı. Artık sessize alma TEK sorguda süzülüyor ve
 * bildirimler TEK insert ile yazılıyor; döngüde yalnızca socket yayını kalıyor
 * (notification.service.broadcastToOrganization ile aynı desen).
 */
export async function notifyWatchers(cardId: string, excludeUserId: string, message: string) {
  const kart = await prisma.card.findUnique({
    where: { id: cardId },
    // id/title/projectId, createNotification'ın socket payload'ındaki `card`
    // alanıyla birebir aynı şekli kurabilmek için çekiliyor.
    select: {
      id: true,
      title: true,
      column: { select: { projectId: true, project: { select: { organizationId: true } } } },
    },
  });
  if (!kart) return;

  const watchers = await prisma.cardWatcher.findMany({
    where: {
      cardId,
      userId: { not: excludeUserId },
      // Organizasyondan ayrilan kisi bildirim ALMAMALI. Izleme kaydi uyelige
      // bagli olmadigi icin ayrilinca silinmiyor; burada susturuluyor.
      // Tekrar uye olursa bildirimler kendiliginden geri gelir.
      user: {
        organizationMemberships: {
          some: { organizationId: kart.column.project.organizationId },
        },
      },
    },
    select: { userId: true },
  });

  if (watchers.length === 0) return;

  // Sessize alma: eskiden her izleyici için ayrı findUnique yapılıyordu, artık
  // kapalı tercihler tek sorguda çekilip küme olarak süzülüyor.
  const susturulmus = await prisma.userNotificationPref.findMany({
    where: {
      enabled: false,
      type: "WATCHED_CARD_ACTIVITY",
      userId: { in: watchers.map((w) => w.userId) },
    },
    select: { userId: true },
  });
  const susturulmusKume = new Set(susturulmus.map((s) => s.userId));
  const aliciIdleri = watchers
    .map((w) => w.userId)
    .filter((userId) => !susturulmusKume.has(userId));

  if (aliciIdleri.length === 0) return;

  // Tek insert. createManyAndReturn kullanılıyor çünkü socket payload'ında
  // gerçek bildirim id'si şart: istemci NOTIFICATION_READ'i id olmadan
  // gönderemiyor.
  const olusanlar = await prisma.notification.createManyAndReturn({
    data: aliciIdleri.map((userId) => ({
      userId,
      type: "WATCHED_CARD_ACTIVITY" as const,
      message,
      cardId,
    })),
    select: { id: true, userId: true, read: true, createdAt: true },
  });

  // Payload şekli createNotification'ınkiyle aynı tutuluyor - istemci tarafı
  // aynı bildirim bileşenini kullanıyor.
  const kartOzeti = {
    id: kart.id,
    title: kart.title,
    column: {
      projectId: kart.column.projectId,
      project: { organizationId: kart.column.project.organizationId },
    },
  };

  for (const bildirim of olusanlar) {
    broadcastToUser(bildirim.userId, SocketEvents.NOTIFICATION_NEW, {
      id: bildirim.id,
      userId: bildirim.userId,
      cardId,
      invitationId: null,
      type: "WATCHED_CARD_ACTIVITY",
      message,
      read: bildirim.read,
      createdAt: bildirim.createdAt.toISOString(),
      card: kartOzeti,
      invitation: null,
    });
  }
}

/**
 * Karta dokunan kişiyi sessizce izleyici yapar (Jira davranışı: yorum
 * yazan kişi otomatik watcher olur).
 *
 * Hata YUTULUYOR ve bilerek: bu yan bir kolaylık, asıl işlemi (yorum
 * oluşturma) başarısız kılmamalı.
 */
export async function autoWatch(cardId: string, userId: string) {
  try {
    await prisma.cardWatcher.createMany({
      data: [{ cardId, userId }],
      skipDuplicates: true,
    });
  } catch {
    // Otomatik izleme yan bir kolaylık - asıl işlemi düşürmesin.
  }
}
