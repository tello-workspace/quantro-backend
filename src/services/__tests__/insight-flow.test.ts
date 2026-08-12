import { describe, it, expect, afterAll } from "vitest";
import * as insightService from "@/services/insight.service";
import { prisma } from "@/lib/prisma";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

const GUN = 24 * 60 * 60 * 1000;

describe("kümülatif akış (CFD)", () => {
  it("sütun geçmişini aktivite kayıtlarından doğru yeniden kurar", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const on_gun_once = new Date(Date.now() - 10 * GUN);
    const uc_gun_once = new Date(Date.now() - 3 * GUN);

    // Kart A: 10 gün önce "To Do"da yaratıldı, 3 gün önce "Bitti"ye taşındı.
    const kartA = await createCard(ws.todo.id, ws.admin.id, "Kart A");
    await prisma.card.update({ where: { id: kartA.id }, data: { createdAt: on_gun_once, columnId: ws.done.id } });
    await prisma.activity.create({
      data: {
        projectId: ws.project.id,
        userId: ws.admin.id,
        type: "CARD_MOVED",
        cardId: kartA.id,
        data: { from: "To Do", to: "Bitti" },
        createdAt: uc_gun_once,
      },
    });

    // Kart B: 5 gün önce "To Do"da yaratıldı, hiç taşınmadı.
    const kartB = await createCard(ws.todo.id, ws.admin.id, "Kart B");
    await prisma.card.update({ where: { id: kartB.id }, data: { createdAt: new Date(Date.now() - 5 * GUN) } });

    const sonuc = await insightService.getCumulativeFlow(ws.project.id, ws.admin.id, 14);

    expect(sonuc.totalCards).toBe(2);
    expect(sonuc.cardsWithMoveHistory).toBe(1);

    const gununSayimi = (gunOnce: number) => {
      const hedefTarih = new Date(Date.now() - gunOnce * GUN).toISOString().slice(0, 10);
      return sonuc.series.find((s) => s.date === hedefTarih)!.counts;
    };

    // 5 gün önce: A henüz taşınmamış (To Do), B yeni yaratılmış (To Do) -> To Do: 2, Bitti: 0
    const besGunOnce = gununSayimi(5);
    expect(besGunOnce[ws.todo.id]).toBe(2);
    expect(besGunOnce[ws.done.id]).toBe(0);

    // Bugün: A "Bitti"de, B hâlâ "To Do"da -> To Do: 1, Bitti: 1
    const bugun = gununSayimi(0);
    expect(bugun[ws.todo.id]).toBe(1);
    expect(bugun[ws.done.id]).toBe(1);
  }, 60000);
});

describe("cycle time", () => {
  it("tamamlanan kartlar için ortalama süreyi doğru hesaplar", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const on_gun_once = new Date(Date.now() - 10 * GUN);
    const uc_gun_once = new Date(Date.now() - 3 * GUN);

    const kart = await createCard(ws.done.id, ws.admin.id, "Tamamlanan kart");
    await prisma.card.update({ where: { id: kart.id }, data: { createdAt: on_gun_once } });
    await prisma.activity.create({
      data: {
        projectId: ws.project.id,
        userId: ws.admin.id,
        type: "CARD_COMPLETED",
        cardId: kart.id,
        createdAt: uc_gun_once,
      },
    });

    const sonuc = await insightService.getCycleTime(ws.project.id, ws.admin.id, 8);

    expect(sonuc.totalDoneCards).toBe(1);
    expect(sonuc.sampledCards).toBe(1);
    expect(sonuc.overallAverageDays).toBe(7);
  }, 60000);

  it("hiç tamamlanan kart yoksa boş sonuç döner", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const sonuc = await insightService.getCycleTime(ws.project.id, ws.admin.id, 8);

    expect(sonuc.totalDoneCards).toBe(0);
    expect(sonuc.overallAverageDays).toBeNull();
  });
});
