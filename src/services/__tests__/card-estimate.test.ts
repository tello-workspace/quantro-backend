import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import * as cardService from "@/services/card.service";
import * as boardService from "@/services/board.service";
import * as insightService from "@/services/insight.service";
import { ForbiddenError } from "@/utils/errors";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

describe("kart efor tahmini (estimate)", () => {
  it("olusturma ve guncellemede kaydedilir, uye degistiremez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const card = await cardService.createCard(ws.todo.id, { title: "Efor tahminli kart", estimate: 5 }, ws.admin.id);
    expect(card.estimate).toBe(5);

    const guncel = await cardService.updateCard(card.id, { estimate: 8 }, ws.admin.id);
    expect(guncel.estimate).toBe(8);

    const temizlenmis = await cardService.updateCard(card.id, { estimate: null }, ws.admin.id);
    expect(temizlenmis.estimate).toBeNull();

    await expect(cardService.updateCard(card.id, { estimate: 3 }, ws.member.id)).rejects.toThrow(ForbiddenError);
  });

  it("board estimate ve estimateUnit'i dondurur", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    await prisma.project.update({ where: { id: ws.project.id }, data: { estimateUnit: "HOURS" } });

    const card = await createCard(ws.todo.id, ws.admin.id, "Kart");
    await prisma.card.update({ where: { id: card.id }, data: { estimate: 13 } });

    const board = await boardService.getBoard(ws.project.id, ws.admin.id);
    expect(board.estimateUnit).toBe("HOURS");
    expect((board.tasks[card.id] as { estimate: number | null }).estimate).toBe(13);
  });

  it("is yuku raporu tahmin varsa onceligi degil tahmini kullanir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const tahminli = await createCard(ws.todo.id, ws.admin.id, "Tahminli - LOW ama 10 puan");
    await prisma.card.update({ where: { id: tahminli.id }, data: { estimate: 10 } });
    await prisma.cardAssignee.create({ data: { cardId: tahminli.id, userId: ws.member.id } });

    const insights = await insightService.getProjectInsights(ws.project.id, ws.admin.id);
    const yuk = insights.workload.find((w) => w.userId === ws.member.id);
    expect(yuk?.weightedLoad).toBe(10);
  });
});
