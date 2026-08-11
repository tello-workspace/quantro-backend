import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import * as timeLogService from "@/services/time-log.service";
import { ForbiddenError } from "@/utils/errors";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

describe("zaman takibi (time log)", () => {
  it("kayit eklenince kartin spentMinutes onbellegi artar", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const card = await createCard(ws.todo.id, ws.admin.id);

    await timeLogService.createTimeLog(card.id, { minutes: 90, note: "Ilk oturum" }, ws.admin.id);
    await timeLogService.createTimeLog(card.id, { minutes: 30 }, ws.member.id);

    const guncelKart = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    expect(guncelKart.spentMinutes).toBe(120);

    const kayitlar = await timeLogService.listTimeLogs(card.id, ws.admin.id);
    expect(kayitlar).toHaveLength(2);
  });

  it("kayit silinince spentMinutes duser, sadece sahibi silebilir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const card = await createCard(ws.todo.id, ws.admin.id);

    const log = await timeLogService.createTimeLog(card.id, { minutes: 45 }, ws.admin.id);

    await expect(timeLogService.deleteTimeLog(log.id, ws.member.id)).rejects.toThrow(ForbiddenError);

    await timeLogService.deleteTimeLog(log.id, ws.admin.id);
    const guncelKart = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    expect(guncelKart.spentMinutes).toBe(0);
  });

  it("organizasyon disindaki kullanici kayit ekleyemez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const card = await createCard(ws.todo.id, ws.admin.id);

    await expect(
      timeLogService.createTimeLog(card.id, { minutes: 10 }, ws.outsider.id),
    ).rejects.toThrow(ForbiddenError);
  });
});
