import { prisma } from "@/lib/prisma";
import { sendDailyDigestEmail } from "@/utils/email";

const DUE_SOON_DAYS = 3;
const APP_URL = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_APP_URL || "https://quantro-yyka.onrender.com";

interface UserDigest {
  dueSoon: { title: string; dueDate: string }[];
  newlyAssigned: { title: string }[];
  pendingRequests: number;
}

// Kullanicinin ozetini toplar. Bos donerse (hicbir bolumde bir sey yoksa)
// e-posta HIC gonderilmez - "sende bugun bir sey yok" maili spam sayilir.
// Disari acik: testler TEK bir kullaniciyi kapsamli sekilde dogrulasin diye
// (runDailyDigest paylasilan DB'deki HERKESI isliyor - test icin uygun degil).
export async function buildDigest(userId: string): Promise<UserDigest> {
  const now = new Date();
  const soon = new Date(now.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000);
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [dueSoonCards, newlyAssignedNotifications, adminOrgIds] = await Promise.all([
    prisma.card.findMany({
      where: {
        assignees: { some: { userId } },
        dueDate: { gte: now, lte: soon },
        column: { isDone: false },
        isArchived: false,
      },
      select: { title: true, dueDate: true },
      orderBy: { dueDate: "asc" },
      take: 10,
    }),
    prisma.notification.findMany({
      where: { userId, type: "ASSIGNED", createdAt: { gte: since } },
      select: { card: { select: { title: true } } },
      take: 10,
    }),
    prisma.organizationMember.findMany({
      where: { userId, role: "ADMIN" },
      select: { organizationId: true },
    }),
  ]);

  const pendingRequests =
    adminOrgIds.length > 0
      ? await prisma.changeRequest.count({
          where: { organizationId: { in: adminOrgIds.map((o) => o.organizationId) }, status: "PENDING" },
        })
      : 0;

  return {
    dueSoon: dueSoonCards
      .filter((c) => c.dueDate)
      .map((c) => ({ title: c.title, dueDate: (c.dueDate as Date).toISOString() })),
    newlyAssigned: newlyAssignedNotifications.filter((n) => n.card).map((n) => ({ title: n.card!.title })),
    pendingRequests,
  };
}

export function isEmpty(digest: UserDigest): boolean {
  return digest.dueSoon.length === 0 && digest.newlyAssigned.length === 0 && digest.pendingRequests === 0;
}

export function bugunMu(d: Date | null, now: Date): boolean {
  if (!d) return false;
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate();
}

// bugunMu ile ayni gun tanimi (UTC), ama DB tarafinda kullanilabilecek bir
// sinir olarak: lastDigestSentAt < gunBasi ise bugun henuz gonderilmemistir.
export function gununBaslangiciUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function runDailyDigest() {
  const now = new Date();
  const gunBasi = gununBaslangiciUTC(now);
  const users = await prisma.user.findMany({
    where: { dailyDigestEnabled: true, emailVerifiedAt: { not: null } },
    select: { id: true, email: true, lastDigestSentAt: true },
  });

  let sent = 0;
  let skippedEmpty = 0;
  let skippedAlreadySent = 0;
  // Gonderimi patlayan kullanicilar ayri sayilir: eskiden bunlar da
  // isaretlendigi icin ikinci kosumda "zatenGonderilmisti" olarak gorunuyor
  // ve toplu bir SMTP arizasi log'da hic fark edilmiyordu.
  let failed = 0;

  for (const user of users) {
    // Ayni gun icinde iki kez tetiklenirse (in-process cron + GitHub Actions,
    // bkz. cron.ts) burada atlanir - gercek e-postanin iki kez gitmesini
    // onleyen TEK yer burasi.
    //
    // Onceden "bugunMu(user.lastDigestSentAt) kontrolu -> sonra update"
    // seklindeydi; iki kosum ayni dakikada baslayinca ikisi de listeyi
    // isaretlenmemis halde okuyup ikisi de e-posta gonderiyordu (kullanici
    // ozeti iki kez aliyordu). Kontrol ile isaretlemeyi KOSULLU TEK bir
    // yazmada birlestiriyoruz: gunun isaretini yalnizca bir kosum
    // alabilir, digerinin count'u 0 doner ve atlar.
    const kilit = await prisma.user.updateMany({
      where: {
        id: user.id,
        OR: [{ lastDigestSentAt: null }, { lastDigestSentAt: { lt: gunBasi } }],
      },
      data: { lastDigestSentAt: now },
    });
    if (kilit.count === 0) {
      skippedAlreadySent += 1;
      continue;
    }

    try {
      // Isaretleme bos ozette de yapilmis oluyor (yukarida, gonderimden
      // once) - "bugun icin kontrol edildi, gonderilecek bir sey yoktu" da
      // bugunku calismayi tamamlar, aksi halde ayni gun tekrar tetiklenince
      // yine ayni bos sonucu hesaplardik.
      const digest = await buildDigest(user.id);

      if (isEmpty(digest)) {
        skippedEmpty += 1;
        continue;
      }
      await sendDailyDigestEmail(user.email, APP_URL, digest);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`[digest] ${user.email} için özet gönderilemedi:`, error);

      // Isaret yukarida gonderimden ONCE atiliyor (yarisi kapatmak icin).
      // Gonderim/hesaplama patladiysa o isaret yerinde kalirsa ozet o gun
      // icin kalicı olarak kayboluyordu: telafi tetiklemesi (GitHub Actions)
      // kullaniciyi "bugun zaten gonderilmisti" diye atliyordu. Bu yuzden
      // isareti eski degerine geri aliyoruz; kosul olarak `now` veriyoruz ki
      // bu arada baska bir kosum yeni bir isaret aldiysa onu ezmeyelim.
      try {
        await prisma.user.updateMany({
          where: { id: user.id, lastDigestSentAt: now },
          data: { lastDigestSentAt: user.lastDigestSentAt },
        });
      } catch (geriAlmaHatasi) {
        console.error(`[digest] ${user.email} için işaret geri alınamadı:`, geriAlmaHatasi);
      }
    }
  }

  console.log(
    `[digest] gönderildi=${sent} boşOlduğuİçinAtlandı=${skippedEmpty} zatenGönderilmişti=${skippedAlreadySent} hata=${failed} toplamKullanıcı=${users.length}`,
  );
  return { sent, skippedEmpty, skippedAlreadySent, failed, totalUsers: users.length };
}
