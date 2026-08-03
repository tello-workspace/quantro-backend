import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";
import { prisma } from "@/lib/prisma";
import * as bulkCardService from "@/services/bulk-card.service";

// Toplu islem tek kartlik servisleri donguyle cagiriyor; buradaki testlerin
// asil isi yetkilerin dongude KAYBOLMADIGINI dogrulamak. Toplu bir uc nokta
// yanlislikla yetki atlatma yolu haline gelirse en pahali hata bu olur.

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
