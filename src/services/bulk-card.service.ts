import { prisma } from "@/lib/prisma";
import { ForbiddenError, NotFoundError } from "@/utils/errors";
import * as cardService from "@/services/card.service";
import { broadcastToProject, SocketEvents } from "@/server/socket";

// Toplu islem, yetki kurallarini YENIDEN YAZMAK yerine tek kartlik servisleri
// cagirir. Boylece izin kontrolu, socket yayini, aktivite kaydi, bildirimler ve
// otomasyonlar tek kartlik islemle birebir ayni kalir - burada ikinci bir yetki
// modeli olusturmak, ileride biri card.service'i degistirdiginde sessizce
// ayrisacak bir kopya yaratirdi.
//
// Islem atomik degil: her kart bagimsiz basarili/basarisiz olabilir ve sonuc
// bunu acikca raporlar. Tek kartlik akis da zaten kart basina yayin yaptigi
// icin bu mevcut modelle tutarli.
//
// PERFORMANS: Kart basina tek kartlik servisi cagirmak ~6 veritabani
// gidis-gelisi demek (kart okuma, yetki, dogrulama, yazma, bildirim,
// aktivite). Uzak veritabaninda gidis-gelis basina ~140ms ile 20 kartlik bir
// secim 15 saniyeyi asiyordu ve kullanici kartlarin teker teker degistigini
// izliyordu.
//
// Bunu ES ZAMANLI kosarak cozmeye calismak YANLIS oldu ve geri alindi:
// veritabani 15 baglantilik paylasilan bir Supabase pooler'i ve yalnizca 5
// es zamanli isle bile "EMAXCONNSESSION: max clients reached in session mode"
// aliniyor. Yani toplu islemi hizlandirmak icin ayni anda sistemi kullanan
// HERKESI 500'e dusurmus olurduk - ustelik havuzun tukenmesi zaten ayri bir
// bilinen sorun.
//
// Dogru cozum es zamanlilik degil, SORGU SAYISINI dusurmek: kartlar birbirinden
// bagimsiz oldugu icin (tasima haric) yetki bir kez kontrol edilip yazma
// islemleri kume bazli tek sorguya iniyor. 20 kart icin ~120 sorgu yerine ~6
// sorgu, tek baglantiyla. Hem daha hizli hem havuza daha az yuk.
//
// Yetki tekrari degil, yetkinin TEK YERDE toplanmasi: tek kartlik servisler
// yetkiyi organizasyon uyeliginin rolunden aliyor ve toplu islemdeki kartlarin
// hepsi ayni projede (yukarida dogrulaniyor), yani cevap tum kartlar icin ayni.
// Kart basina sormak ayni soruyu N kez sormakti.

/**
 * Toplu islemin yetkisini BIR KEZ cozer. checkColumnAccess ile ayni kurali
 * uygular: organizasyon uyesi olmayan reddedilir, rol geri doner.
 */
async function projeYetkisi(projectId: string, userId: string) {
  const proje = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  if (!proje) throw new NotFoundError("Proje");

  const uye = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: proje.organizationId, userId } },
    select: { role: true },
  });
  if (!uye) throw new ForbiddenError("Bu projeye erişim yetkiniz yok");

  return { role: uye.role, organizationId: proje.organizationId };
}

export type BulkAction = "move" | "assign" | "label" | "archive" | "delete";

export interface BulkInput {
  cardIds: string[];
  action: BulkAction;
  columnId?: string;
  assigneeIds?: string[];
  labelId?: string;
  // Tasima icin kart basina hedef pozisyon. Verilmezse updateCard kartlari
  // sutunun sonuna ekler; surukle-birak ile tasindiginda kullanici kartlari
  // belirli bir noktaya birakiyor ve sonuc oraya oturmali.
  positions?: Record<string, number>;
}

export interface BulkResult {
  basarili: string[];
  basarisiz: { cardId: string; sebep: string }[];
}

// Kartlarin hepsi gercekten bu projeye mi ait? Istemciden gelen id listesine
// guvenmiyoruz: baska bir projenin karti listeye sizerse, tek kartlik servis
// yetkiyi yine reddederdi ama hata mesaji kafa karistirici olurdu.
async function projeKartlariniDogrula(projectId: string, cardIds: string[]) {
  const kartlar = await prisma.card.findMany({
    where: { id: { in: cardIds }, column: { projectId } },
    select: { id: true },
  });

  const gecerli = new Set(kartlar.map((k) => k.id));
  return {
    gecerli: cardIds.filter((id) => gecerli.has(id)),
    gecersiz: cardIds.filter((id) => !gecerli.has(id)),
  };
}

export async function bulkCardAction(
  projectId: string,
  input: BulkInput,
  userId: string,
): Promise<BulkResult> {
  const { gecerli, gecersiz } = await projeKartlariniDogrula(projectId, input.cardIds);

  const sonuc: BulkResult = {
    basarili: [],
    basarisiz: gecersiz.map((cardId) => ({ cardId, sebep: "Kart bu projede bulunamadı" })),
  };

  if (gecerli.length === 0) return sonuc;

  // Hedef kolon dogrulamasi bir kez yapiliyor - her kart icin tekrarlamak
  // gereksiz sorgu olurdu.
  if (input.action === "move") {
    if (!input.columnId) throw new NotFoundError("Hedef sütun");
    const kolon = await prisma.column.findFirst({
      where: { id: input.columnId, projectId },
      select: { id: true },
    });
    if (!kolon) throw new NotFoundError("Hedef sütun");
  }

  if (input.action === "label" && !input.labelId) {
    throw new NotFoundError("Etiket");
  }

  // TASIMA tek kartlik servise ve SIRALI akisa bagli kalmali: hedef pozisyon
  // verilmediginde updateCard "sutundaki en buyuk pozisyonu oku, bir fazlasini
  // yaz" yapiyor - kartlar birbirini etkiliyor. Ayrica tasima otomasyon
  // tetikliyor, bagimlilik bildirimi gonderiyor ve CARD_MOVED aktivitesi
  // yaziyor; bunlari kume bazli yeniden yazmak gercek bir davranis kopyasi
  // uretirdi. Tasimada secim tipik olarak kucuk oldugu icin maliyet kabul
  // edilebilir.
  if (input.action === "move") {
    for (const cardId of gecerli) {
      try {
        await cardService.updateCard(
          cardId,
          { columnId: input.columnId, position: input.positions?.[cardId] },
          userId,
        );
        sonuc.basarili.push(cardId);
      } catch (error) {
        sonuc.basarisiz.push({ cardId, sebep: hataMesaji(error) });
      }
    }
    return sonuc;
  }

  // Yetki BIR KEZ. Reddedilirse kartlarin hepsi ayni sebeple basarisiz
  // sayiliyor - istisna firlatmak yerine, cunku toplu islemin sozlesmesi
  // "kart basina basarili/basarisiz raporla".
  let yetki: Awaited<ReturnType<typeof projeYetkisi>>;
  try {
    yetki = await projeYetkisi(projectId, userId);
  } catch (error) {
    return hepsiBasarisiz(sonuc, gecerli, hataMesaji(error));
  }

  const sadeceAdmin = (mesaj: string) => yetki.role !== "ADMIN" && hepsiBasarisiz(sonuc, gecerli, mesaj);

  switch (input.action) {
    case "assign": {
      const reddedildi = sadeceAdmin("Sadece adminler görev ataması yapabilir");
      if (reddedildi) return reddedildi;
      return await topluAta(projectId, gecerli, input.assigneeIds ?? [], yetki.organizationId, sonuc);
    }

    case "archive":
      // Arsivleme tek kartlik akista da yalnizca uyelik istiyor, ADMIN sarti yok.
      return await topluArsivle(projectId, gecerli, sonuc);

    case "delete": {
      const reddedildi = sadeceAdmin(
        "Kartı sadece adminler silebilir. Silme talebi gönderebilirsiniz.",
      );
      if (reddedildi) return reddedildi;
      return await topluSil(projectId, gecerli, sonuc);
    }

    case "label":
      return await topluEtiketle(projectId, gecerli, input.labelId!, sonuc);
  }

  return sonuc;
}

function hataMesaji(error: unknown): string {
  return error instanceof ForbiddenError || error instanceof NotFoundError
    ? error.message
    : "İşlem uygulanamadı";
}

function hepsiBasarisiz(sonuc: BulkResult, cardIds: string[], sebep: string): BulkResult {
  for (const cardId of cardIds) sonuc.basarisiz.push({ cardId, sebep });
  return sonuc;
}

// ------------------------------------------------------------ kume islemleri

async function topluAta(
  projectId: string,
  cardIds: string[],
  assigneeIds: string[],
  organizationId: string,
  sonuc: BulkResult,
): Promise<BulkResult> {
  // Atanacak kisiler gercekten bu organizasyonun uyesi mi - kart basina degil,
  // bir kez: liste tum kartlar icin ayni.
  if (assigneeIds.length > 0) {
    const uyeler = await prisma.organizationMember.findMany({
      where: { organizationId, userId: { in: assigneeIds } },
      select: { userId: true },
    });
    if (uyeler.length !== assigneeIds.length) {
      return hepsiBasarisiz(sonuc, cardIds, "Atanan kişilerden biri bu organizasyonun üyesi değil");
    }
  }

  // Bildirim YALNIZCA yeni atananlara gitmeli; hangi kartta kimin zaten atali
  // oldugunu tek sorguda ogreniyoruz.
  const mevcut = await prisma.cardAssignee.findMany({
    where: { cardId: { in: cardIds } },
    select: { cardId: true, userId: true },
  });
  const mevcutKume = new Set(mevcut.map((m) => `${m.cardId}:${m.userId}`));

  const kartlar = await prisma.card.findMany({
    where: { id: { in: cardIds } },
    select: { id: true, title: true },
  });

  await prisma.$transaction([
    prisma.cardAssignee.deleteMany({ where: { cardId: { in: cardIds } } }),
    ...(assigneeIds.length > 0
      ? [
          prisma.cardAssignee.createMany({
            data: cardIds.flatMap((cardId) => assigneeIds.map((userId) => ({ cardId, userId }))),
            skipDuplicates: true,
          }),
        ]
      : []),
    prisma.card.updateMany({
      where: { id: { in: cardIds } },
      data: { lastActivityAt: new Date() },
    }),
  ]);

  const yeniBildirimler = kartlar.flatMap((kart) =>
    assigneeIds
      .filter((userId) => !mevcutKume.has(`${kart.id}:${userId}`))
      .map((userId) => ({
        userId,
        type: "ASSIGNED" as const,
        message: `"${kart.title}" kartı size atandı`,
        cardId: kart.id,
      })),
  );
  if (yeniBildirimler.length > 0) {
    await prisma.notification.createMany({ data: yeniBildirimler });
  }

  // Socket yayini BELLEK ICI - veritabanina gitmiyor, bu yuzden kart basina
  // yapmak maliyetsiz ve istemci sozlesmesini degistirmiyor.
  const atananlar = assigneeIds.length
    ? await prisma.user.findMany({
        where: { id: { in: assigneeIds } },
        select: { id: true, name: true, avatarUrl: true },
      })
    : [];
  for (const kart of kartlar) {
    broadcastToProject(projectId, SocketEvents.CARD_ASSIGNED, {
      cardId: kart.id,
      cardTitle: kart.title,
      assignees: atananlar,
      projectId,
    });
  }

  sonuc.basarili.push(...cardIds);
  return sonuc;
}

async function topluArsivle(
  projectId: string,
  cardIds: string[],
  sonuc: BulkResult,
): Promise<BulkResult> {
  // Zaten arsivli olanlari tekrar damgalamiyoruz (tek kartlik akis da
  // idempotent), ama sonucta hepsi basarili sayiliyor - istenen son durum
  // saglandi.
  await prisma.card.updateMany({
    where: { id: { in: cardIds }, isArchived: false },
    data: { isArchived: true, archivedAt: new Date() },
  });

  for (const cardId of cardIds) {
    broadcastToProject(projectId, SocketEvents.CARD_UPDATED, {
      id: cardId,
      isArchived: true,
      projectId,
    });
  }

  sonuc.basarili.push(...cardIds);
  return sonuc;
}

async function topluSil(
  projectId: string,
  cardIds: string[],
  sonuc: BulkResult,
): Promise<BulkResult> {
  const etiketBaglari = await prisma.cardLabel.findMany({
    where: { cardId: { in: cardIds } },
    select: { labelId: true },
  });
  const etkilenenEtiketler = [...new Set(etiketBaglari.map((e) => e.labelId))];

  await prisma.card.deleteMany({ where: { id: { in: cardIds } } });

  // Oksuz etiket temizligi: tek kartlik akis etiket basina COUNT atiyordu.
  // Burada kalanlari tek sorguda bulup farkini siliyoruz.
  if (etkilenenEtiketler.length > 0) {
    const halaKullanilan = await prisma.cardLabel.findMany({
      where: { labelId: { in: etkilenenEtiketler } },
      select: { labelId: true },
      distinct: ["labelId"],
    });
    const kullanilanKume = new Set(halaKullanilan.map((e) => e.labelId));
    const oksuz = etkilenenEtiketler.filter((id) => !kullanilanKume.has(id));
    if (oksuz.length > 0) {
      await prisma.label
        .deleteMany({ where: { id: { in: oksuz } } })
        .catch((err) =>
          console.warn("[Label Cleanup] Öksüz etiketler silinemedi:", err.message),
        );
    }
  }

  for (const cardId of cardIds) {
    broadcastToProject(projectId, SocketEvents.CARD_DELETED, { cardId, projectId });
  }

  sonuc.basarili.push(...cardIds);
  return sonuc;
}

async function topluEtiketle(
  projectId: string,
  cardIds: string[],
  labelId: string,
  sonuc: BulkResult,
): Promise<BulkResult> {
  const etiket = await prisma.label.findFirst({
    where: { id: labelId, projectId },
    select: { id: true },
  });
  if (!etiket) return hepsiBasarisiz(sonuc, cardIds, "Etiket bulunamadı");

  // skipDuplicates: zaten ekli etiket hata degil, istenen son durum saglanmis.
  // Tek kartlik akis 409 firlatiyor ve toplu akis onu zaten basari sayiyordu -
  // burada dogrudan dogru davranisi yapiyoruz.
  await prisma.cardLabel.createMany({
    data: cardIds.map((cardId) => ({ cardId, labelId })),
    skipDuplicates: true,
  });

  for (const cardId of cardIds) {
    broadcastToProject(projectId, SocketEvents.CARD_UPDATED, { id: cardId, projectId });
  }

  sonuc.basarili.push(...cardIds);
  return sonuc;
}
