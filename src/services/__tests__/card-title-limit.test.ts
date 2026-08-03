import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, cleanup } from "@/test/fixtures";
import { prisma } from "@/lib/prisma";
import * as cardService from "@/services/card.service";
import { ValidationError } from "@/utils/errors";

// AI arac calistiricisi ve otomasyon motoru cardService'i DOGRUDAN cagiriyor,
// route'un Zod semasindan gecmiyorlar. Bu yuzden 200 karakteri asan basliklar
// veritabanina girmisti ve o kartlarda her PATCH dogrulamada patliyordu -
// kart kalici olarak duzenlenemez hale geliyordu (atama, tasima, aciklama;
// hicbiri kaydedilemiyordu).

const UZUN = "x".repeat(631);

describe("kart baslik siniri", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("servis katmani uzun basligi kisaltir (AI/otomasyon yolu)", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const card = await cardService.createCard(todo.id, { title: UZUN }, admin.id);

    expect(card.title.length).toBe(200);
    expect(card.title.endsWith("…")).toBe(true);
  });

  it("kisaltilan basligin tamami aciklamaya tasinir - metin kaybolmaz", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const card = await cardService.createCard(todo.id, { title: UZUN }, admin.id);
    const kayit = await prisma.card.findUnique({ where: { id: card.id }, select: { description: true } });

    expect(kayit?.description).toContain(UZUN);
  });

  it("mevcut aciklama korunur, tasan baslik altina eklenir", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const card = await cardService.createCard(
      todo.id,
      { title: UZUN, description: "Onceden yazilmis aciklama" },
      admin.id,
    );
    const kayit = await prisma.card.findUnique({ where: { id: card.id }, select: { description: true } });

    expect(kayit?.description).toContain("Onceden yazilmis aciklama");
    expect(kayit?.description).toContain(UZUN);
  });

  it("sinir altindaki baslik oldugu gibi kalir", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const card = await cardService.createCard(todo.id, { title: "Normal baslik" }, admin.id);
    expect(card.title).toBe("Normal baslik");
  });

  // Asil regresyon: gecmiste kaydedilmis uzun baslikli bir kart yine
  // duzenlenebilmeli. Arayuz her kaydetmede degismemis basligi da geri
  // gonderiyor; sinir kosulsuz uygulansaydi bu kart sonsuza dek kilitli
  // kalirdi.
  it("var olan uzun baslikli kart, baslik degismeden guncellenebilir", async () => {
    const { admin, member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    // Servisi atlayarak dogrudan yaziyoruz - eski verinin birebir taklidi
    const bozuk = await prisma.card.create({
      data: { columnId: todo.id, title: UZUN, creatorId: admin.id, position: 1 },
    });

    const guncel = await cardService.updateCard(
      bozuk.id,
      { title: UZUN, assigneeIds: [admin.id, member.id] },
      admin.id,
    );

    expect(guncel).toBeTruthy();
    const atamalar = await prisma.cardAssignee.count({ where: { cardId: bozuk.id } });
    expect(atamalar).toBe(2);
  });

  it("baslik gercekten uzatilmaya calisilirsa reddedilir", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const card = await cardService.createCard(todo.id, { title: "Kisa" }, admin.id);

    await expect(
      cardService.updateCard(card.id, { title: UZUN }, admin.id),
    ).rejects.toThrow(ValidationError);
  });
});
