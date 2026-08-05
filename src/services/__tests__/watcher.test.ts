import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";
import { prisma } from "@/lib/prisma";
import * as watcherService from "@/services/watcher.service";
import * as commentService from "@/services/comment.service";
import * as cardService from "@/services/card.service";
import * as bulkCardService from "@/services/bulk-card.service";

// Kart izleme bir kez yapilip (8aed3ab) "kullanissiz" diye kaldirilmisti
// (c9aef48). Kaldirilma sebebi fikrin kendisi degil, YARIM olmasiydi: abone
// olabiliyordun ama neyi izledigini gorebilecegin hicbir yer yoktu.
//
// Bu yuzden testlerin agirligi TUKETME tarafinda: getWatchedCards gercekten
// dogru listeyi donuyor mu, kendi eyleminden bildirim gitmiyor mu, yetkisiz
// kisi baskasinin projesindeki karti izleyebiliyor mu.

describe("watcher.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("izlemeye alir ve durumu bildirir", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const kart = await createCard(todo.id, admin.id);

    const once = await watcherService.getWatchStatus(kart.id, admin.id);
    expect(once).toEqual({ isWatching: false, watcherCount: 0 });

    const sonra = await watcherService.watchCard(kart.id, admin.id);
    expect(sonra).toEqual({ isWatching: true, watcherCount: 1 });
  });

  it("ayni karti iki kez izlemek hata vermez, sayac artmaz", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const kart = await createCard(todo.id, admin.id);

    await watcherService.watchCard(kart.id, admin.id);
    const ikinci = await watcherService.watchCard(kart.id, admin.id);

    expect(ikinci).toEqual({ isWatching: true, watcherCount: 1 });
  });

  it("izlemeyi birakinca kayit silinir", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const kart = await createCard(todo.id, admin.id);

    await watcherService.watchCard(kart.id, admin.id);
    const sonuc = await watcherService.unwatchCard(kart.id, admin.id);

    expect(sonuc).toEqual({ isWatching: false, watcherCount: 0 });
  });

  it("organizasyon uyesi olmayan karti izleyemez", async () => {
    const { admin, outsider, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, outsider.id);
    const kart = await createCard(todo.id, admin.id);

    await expect(watcherService.watchCard(kart.id, outsider.id)).rejects.toThrow();
  });

  // ---------------------------------------------------------- tuketme tarafi

  it("izlediklerim listesi kartin projesi ve kolonuyla birlikte doner", async () => {
    const { admin, member, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const kart = await createCard(todo.id, admin.id, "Izlenen kart");

    await watcherService.watchCard(kart.id, member.id);
    const liste = await watcherService.getWatchedCards(member.id);

    expect(liste).toHaveLength(1);
    expect(liste[0]).toMatchObject({
      id: kart.id,
      title: "Izlenen kart",
      columnId: todo.id,
      columnName: "To Do",
      projectId: project.id,
      isDone: false,
    });
  });

  it("izlenmeyen kart listede cikmaz", async () => {
    const { admin, member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    await createCard(todo.id, admin.id);

    const liste = await watcherService.getWatchedCards(member.id);
    expect(liste).toHaveLength(0);
  });

  it("arsivlenen kart listeden dusar ama abonelik silinmez", async () => {
    const { admin, member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const kart = await createCard(todo.id, admin.id);

    await watcherService.watchCard(kart.id, member.id);
    await prisma.card.update({
      where: { id: kart.id },
      data: { isArchived: true, archivedAt: new Date() },
    });

    expect(await watcherService.getWatchedCards(member.id)).toHaveLength(0);

    // Abonelik duruyor: kart geri yuklenirse izleme kaldigi yerden devam etmeli.
    const kayit = await prisma.cardWatcher.findUnique({
      where: { cardId_userId: { cardId: kart.id, userId: member.id } },
    });
    expect(kayit).not.toBeNull();
  });

  // Gercek bir testte yakalandi: kullanici karti izlemeye alip organizasyondan
  // ayrildi. CardWatcher karta ve kullaniciya bagli, UYELIGE degil - yani kayit
  // duruyor. Uyelik filtresi olmadan ayrilan kisi kart basligini, proje adini,
  // kolonunu ve KIMLERE ATANDIGINI gormeye devam ediyordu.
  it("organizasyondan ayrilan kisi izlediklerinde o karti GOREMEZ", async () => {
    const { admin, member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const kart = await createCard(todo.id, admin.id);

    await watcherService.watchCard(kart.id, member.id);
    expect(await watcherService.getWatchedCards(member.id)).toHaveLength(1);

    await prisma.organizationMember.deleteMany({
      where: { organizationId: org.id, userId: member.id },
    });

    expect(await watcherService.getWatchedCards(member.id)).toHaveLength(0);
  });

  it("tekrar uye olunca izleme kaldigi yerden devam eder", async () => {
    const { admin, member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const kart = await createCard(todo.id, admin.id);

    await watcherService.watchCard(kart.id, member.id);
    await prisma.organizationMember.deleteMany({
      where: { organizationId: org.id, userId: member.id },
    });
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: member.id, role: "MEMBER" },
    });

    // Abonelik silinmedi, sadece susturulmustu.
    expect(await watcherService.getWatchedCards(member.id)).toHaveLength(1);
  });

  // ------------------------------------------------------------- bildirimler

  it("yorum yapilinca izleyiciye bildirim gider", async () => {
    const { admin, member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const kart = await createCard(todo.id, admin.id, "Yorumlanan kart");

    await watcherService.watchCard(kart.id, member.id);
    await commentService.createComment(kart.id, { text: "bir yorum" }, admin.id);

    const bildirimler = await prisma.notification.findMany({
      where: { userId: member.id, type: "WATCHED_CARD_ACTIVITY", cardId: kart.id },
    });
    expect(bildirimler).toHaveLength(1);
  });

  it("kendi yorumundan bildirim gelmez", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const kart = await createCard(todo.id, admin.id);

    await watcherService.watchCard(kart.id, admin.id);
    await commentService.createComment(kart.id, { text: "kendi yorumum" }, admin.id);

    const bildirimler = await prisma.notification.findMany({
      where: { userId: admin.id, type: "WATCHED_CARD_ACTIVITY" },
    });
    expect(bildirimler).toHaveLength(0);
  });

  it("organizasyondan ayrilan izleyiciye bildirim GITMEZ", async () => {
    const { admin, member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const kart = await createCard(todo.id, admin.id);

    await watcherService.watchCard(kart.id, member.id);
    await prisma.organizationMember.deleteMany({
      where: { organizationId: org.id, userId: member.id },
    });

    await commentService.createComment(kart.id, { text: "bir yorum" }, admin.id);

    const bildirimler = await prisma.notification.findMany({
      where: { userId: member.id, type: "WATCHED_CARD_ACTIVITY", cardId: kart.id },
    });
    expect(bildirimler).toHaveLength(0);
  });

  it("yorum yazan kisi otomatik izleyici olur", async () => {
    const { admin, member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const kart = await createCard(todo.id, admin.id);

    await commentService.createComment(kart.id, { text: "ilgileniyorum" }, member.id);

    const durum = await watcherService.getWatchStatus(kart.id, member.id);
    expect(durum.isWatching).toBe(true);
  });

  it("kart baska sutuna tasininca izleyiciye bildirim gider", async () => {
    const { admin, member, org, todo, done } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const kart = await createCard(todo.id, admin.id);

    await watcherService.watchCard(kart.id, member.id);
    await cardService.updateCard(kart.id, { columnId: done.id }, admin.id);

    const bildirimler = await prisma.notification.findMany({
      where: { userId: member.id, type: "WATCHED_CARD_ACTIVITY", cardId: kart.id },
    });
    expect(bildirimler).toHaveLength(1);
    expect(bildirimler[0].message).toContain("Bitti");
  });

  // ------------------------------------------------------------ toplu islem

  it("toplu izleme secili kartlarin hepsini abone yapar", async () => {
    const { admin, member, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const kartlar = [
      await createCard(todo.id, admin.id),
      await createCard(todo.id, admin.id),
      await createCard(todo.id, admin.id),
    ];

    const sonuc = await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: kartlar.map((k) => k.id), action: "watch" },
      member.id,
    );

    expect(sonuc.basarili).toHaveLength(3);
    expect(await watcherService.getWatchedCards(member.id)).toHaveLength(3);
  });

  it("toplu izleme MEMBER icin de calisir - kisisel abonelik, admin sarti yok", async () => {
    const { admin, member, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const kart = await createCard(todo.id, admin.id);

    const sonuc = await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: [kart.id], action: "watch" },
      member.id,
    );

    expect(sonuc.basarisiz).toHaveLength(0);
  });

  it("toplu izlemeyi birakma yalnizca KENDI aboneligini siler", async () => {
    const { admin, member, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const kart = await createCard(todo.id, admin.id);

    await watcherService.watchCard(kart.id, admin.id);
    await watcherService.watchCard(kart.id, member.id);

    await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: [kart.id], action: "unwatch" },
      member.id,
    );

    expect((await watcherService.getWatchStatus(kart.id, member.id)).isWatching).toBe(false);
    expect((await watcherService.getWatchStatus(kart.id, admin.id)).isWatching).toBe(true);
  });

  it("toplu izlemede baska projenin karti sizamaz", async () => {
    const ilk = await createWorkspace();
    const ikinci = await createWorkspace();
    orgIds.push(ilk.org.id, ikinci.org.id);
    userIds.push(ilk.admin.id, ilk.member.id, ikinci.admin.id);

    const bizimKart = await createCard(ilk.todo.id, ilk.admin.id);
    const yabanciKart = await createCard(ikinci.todo.id, ikinci.admin.id);

    const sonuc = await bulkCardService.bulkCardAction(
      ilk.project.id,
      { cardIds: [bizimKart.id, yabanciKart.id], action: "watch" },
      ilk.member.id,
    );

    expect(sonuc.basarili).toEqual([bizimKart.id]);
    expect(sonuc.basarisiz).toHaveLength(1);
    expect(sonuc.basarisiz[0].cardId).toBe(yabanciKart.id);
  });

  it("toggleWatchMany erisilemeyen karti atlanan olarak raporlar", async () => {
    const ilk = await createWorkspace();
    const ikinci = await createWorkspace();
    orgIds.push(ilk.org.id, ikinci.org.id);
    userIds.push(ilk.admin.id, ikinci.admin.id);

    const bizimKart = await createCard(ilk.todo.id, ilk.admin.id);
    const yabanciKart = await createCard(ikinci.todo.id, ikinci.admin.id);

    const sonuc = await watcherService.toggleWatchMany(
      [bizimKart.id, yabanciKart.id],
      ilk.admin.id,
      true,
    );

    expect(sonuc.islenen).toEqual([bizimKart.id]);
    expect(sonuc.atlanan).toEqual([yabanciKart.id]);
  });
});
