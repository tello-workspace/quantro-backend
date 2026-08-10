import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";
import { prisma } from "@/lib/prisma";
import * as bulkCardService from "@/services/bulk-card.service";

// Toplu islem artik yetkiyi BIR KEZ kontrol edip yazmalari kume bazli tek
// sorguya indiriyor (tasima haric). Buradaki testlerin asil isi yetkilerin bu
// sadelestirmede KAYBOLMADIGINI dogrulamak: uye atayamaz, uye silemez,
// outsider hicbir seye dokunamaz, baska projenin karti sizamaz. Toplu bir uc
// nokta yanlislikla yetki atlatma yolu haline gelirse en pahali hata bu olur.

describe("bulk-card.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("secili kartlarin hepsini hedef sutuna tasir", async () => {
    const { admin, org, project, todo, done } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const kartlar = [
      await createCard(todo.id, admin.id),
      await createCard(todo.id, admin.id),
      await createCard(todo.id, admin.id),
    ];

    const sonuc = await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: kartlar.map((k) => k.id), action: "move", columnId: done.id },
      admin.id,
    );

    expect(sonuc.basarili).toHaveLength(3);
    expect(sonuc.basarisiz).toHaveLength(0);

    const tasinmis = await prisma.card.findMany({
      where: { id: { in: kartlar.map((k) => k.id) } },
      select: { columnId: true },
    });
    expect(tasinmis.every((k) => k.columnId === done.id)).toBe(true);
  });

  it("verilen pozisyonlar korunur - surukle-birak sirasi bozulmaz", async () => {
    const { admin, org, project, todo, done } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const a = await createCard(todo.id, admin.id, "A");
    const b = await createCard(todo.id, admin.id, "B");
    const c = await createCard(todo.id, admin.id, "C");

    // Kullanici A,B,C sirasiyla birakti
    await bulkCardService.bulkCardAction(
      project.id,
      {
        cardIds: [a.id, b.id, c.id],
        action: "move",
        columnId: done.id,
        positions: { [a.id]: 10, [b.id]: 20, [c.id]: 30 },
      },
      admin.id,
    );

    const sirali = await prisma.card.findMany({
      where: { columnId: done.id },
      orderBy: { position: "asc" },
      select: { id: true, position: true },
    });

    expect(sirali.map((k) => k.id)).toEqual([a.id, b.id, c.id]);
    expect(sirali.map((k) => k.position)).toEqual([10, 20, 30]);
  });

  it("pozisyon verilmezse kartlar sutunun sonuna eklenir", async () => {
    const { admin, org, project, todo, done } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const mevcut = await prisma.card.create({
      data: { columnId: done.id, number: 903, title: "Mevcut", creatorId: admin.id, position: 5 },
    });
    const yeni = await createCard(todo.id, admin.id);

    await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: [yeni.id], action: "move", columnId: done.id },
      admin.id,
    );

    const tasinan = await prisma.card.findUnique({ where: { id: yeni.id } });
    const mevcutKart = await prisma.card.findUnique({ where: { id: mevcut.id } });
    expect(tasinan!.position).toBeGreaterThan(mevcutKart!.position);
  });

  it("uye kart tasiyabilir", async () => {
    const { admin, member, org, project, todo, done } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    const card = await createCard(todo.id, admin.id);

    const sonuc = await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: [card.id], action: "move", columnId: done.id },
      member.id,
    );

    expect(sonuc.basarili).toEqual([card.id]);
  });

  it("uye toplu silme yapamaz - kartlar yerinde kalir", async () => {
    const { admin, member, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    const card = await createCard(todo.id, admin.id);

    const sonuc = await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: [card.id], action: "delete" },
      member.id,
    );

    expect(sonuc.basarili).toHaveLength(0);
    expect(sonuc.basarisiz).toHaveLength(1);

    const halaVar = await prisma.card.findUnique({ where: { id: card.id } });
    expect(halaVar).not.toBeNull();
  });

  it("uye toplu atama yapamaz", async () => {
    const { admin, member, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    const card = await createCard(todo.id, admin.id);

    const sonuc = await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: [card.id], action: "assign", assigneeIds: [member.id] },
      member.id,
    );

    expect(sonuc.basarisiz).toHaveLength(1);
    const atamalar = await prisma.cardAssignee.count({ where: { cardId: card.id } });
    expect(atamalar).toBe(0);
  });

  it("outsider hicbir karta dokunamaz", async () => {
    const { admin, outsider, org, project, todo, done } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, outsider.id);

    const card = await createCard(todo.id, admin.id);

    const sonuc = await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: [card.id], action: "move", columnId: done.id },
      outsider.id,
    );

    expect(sonuc.basarili).toHaveLength(0);
    expect(sonuc.basarisiz).toHaveLength(1);

    const dokunulmamis = await prisma.card.findUnique({ where: { id: card.id } });
    expect(dokunulmamis?.columnId).toBe(todo.id);
  });

  it("baska projenin karti listeye sizerse reddedilir", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    orgIds.push(a.org.id, b.org.id);
    userIds.push(a.admin.id, a.member.id, b.admin.id, b.member.id);

    const kendiKart = await createCard(a.todo.id, a.admin.id);
    const yabanciKart = await createCard(b.todo.id, b.admin.id);

    const sonuc = await bulkCardService.bulkCardAction(
      a.project.id,
      { cardIds: [kendiKart.id, yabanciKart.id], action: "move", columnId: a.done.id },
      a.admin.id,
    );

    expect(sonuc.basarili).toEqual([kendiKart.id]);
    expect(sonuc.basarisiz).toHaveLength(1);
    expect(sonuc.basarisiz[0].cardId).toBe(yabanciKart.id);

    // Yabanci kart yerinde kalmali
    const yabanci = await prisma.card.findUnique({ where: { id: yabanciKart.id } });
    expect(yabanci?.columnId).toBe(b.todo.id);
  });

  it("kismi basari raporlanir - yetkili kart islenir, yetkisiz atlanir", async () => {
    const { admin, org, project, todo, done } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const gercek = await createCard(todo.id, admin.id);

    const sonuc = await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: [gercek.id, "olmayan-kart-id"], action: "move", columnId: done.id },
      admin.id,
    );

    expect(sonuc.basarili).toEqual([gercek.id]);
    expect(sonuc.basarisiz).toEqual([
      { cardId: "olmayan-kart-id", sebep: "Kart bu projede bulunamadı" },
    ]);
  });

  // Atama/etiket/arsiv/silme artik kart basina servis cagirmak yerine KUME
  // BAZLI tek sorguyla yaziliyor. Bu testler kume yolunun iki sozunu koruyor:
  // hicbir kart atlanmiyor ve sonuclar GIRIS SIRASINDA raporlaniyor - sira
  // bozulursa kullaniciya "3. kart atlandi" gibi yanlis bir esleme gosterilir.
  it("cok sayida kartta hicbiri atlanmaz", async () => {
    const { admin, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    // Tek kartlik akista bu 12 kart ~27 saniye suruyordu; kume bazli yolda
    // sorgu sayisi kart sayisiyla dogru orantili buyumuyor.
    const kartlar = [];
    for (let i = 0; i < 12; i++) kartlar.push(await createCard(todo.id, admin.id));
    const idler = kartlar.map((k) => k.id);

    const sonuc = await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: idler, action: "assign", assigneeIds: [admin.id] },
      admin.id,
    );

    expect(sonuc.basarisiz).toHaveLength(0);
    expect(sonuc.basarili).toEqual(idler); // sira korunuyor

    const atamalar = await prisma.cardAssignee.findMany({
      where: { cardId: { in: idler } },
      select: { cardId: true },
    });
    expect(new Set(atamalar.map((a) => a.cardId)).size).toBe(12);
  });

  it("basarisizlar giris sirasindaki yerini korur", async () => {
    const { admin, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const k1 = await createCard(todo.id, admin.id);
    const k2 = await createCard(todo.id, admin.id);
    const k3 = await createCard(todo.id, admin.id);

    // Gecerli ve gecersiz id'ler ic ice: kume yolu gecerli/gecersiz ayrimini
    // bastan yapiyor, sonuclari karistirirsa basarisiz listesi yanlis id'leri
    // gosterirdi.
    const sonuc = await bulkCardService.bulkCardAction(
      project.id,
      {
        cardIds: [k1.id, "yok-1", k2.id, "yok-2", k3.id],
        action: "assign",
        assigneeIds: [admin.id],
      },
      admin.id,
    );

    expect(sonuc.basarili).toEqual([k1.id, k2.id, k3.id]);
    expect(sonuc.basarisiz.map((b) => b.cardId)).toEqual(["yok-1", "yok-2"]);
  });

  it("ayni etiket iki kez eklenirse hata sayilmaz", async () => {
    const { admin, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const card = await createCard(todo.id, admin.id);
    const label = await prisma.label.create({
      data: { name: "acil", color: "#EF4444", projectId: project.id },
    });

    await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: [card.id], action: "label", labelId: label.id },
      admin.id,
    );

    // Ikinci kez: etiket zaten ekli, istenen son durum saglanmis durumda
    const ikinci = await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: [card.id], action: "label", labelId: label.id },
      admin.id,
    );

    expect(ikinci.basarili).toEqual([card.id]);
    expect(ikinci.basarisiz).toHaveLength(0);
  });

  it("toplu arsivleme kartlari panodan gizler", async () => {
    const { admin, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const kartlar = [await createCard(todo.id, admin.id), await createCard(todo.id, admin.id)];

    const sonuc = await bulkCardService.bulkCardAction(
      project.id,
      { cardIds: kartlar.map((k) => k.id), action: "archive" },
      admin.id,
    );

    expect(sonuc.basarili).toHaveLength(2);

    const arsivli = await prisma.card.findMany({
      where: { id: { in: kartlar.map((k) => k.id) } },
      select: { isArchived: true },
    });
    expect(arsivli.every((k) => k.isArchived)).toBe(true);
  });
});
