import { describe, it, expect, afterAll } from "vitest";
import * as digestService from "@/services/digest.service";
import { prisma } from "@/lib/prisma";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";

// runDailyDigest() paylasilan DB'deki HERKESI isliyor (gercek uretim
// davranisi bu) - bu yuzden burada onun yerine tek-kullanici kapsamli
// buildDigest/bugunMu/isEmpty test ediliyor (digest.service.ts'te disari
// acildi). runDailyDigest'in kendisini butunsel calistirmak paylasilan
// test ortamindaki TUM kullanicilarin lastDigestSentAt'ini degistirir -
// bu dosyanin disina tasan bir yan etki, kabul edilemez.

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

const GUN = 24 * 60 * 60 * 1000;

describe("günlük özet - buildDigest", () => {
  it("yaklaşan teslim tarihi olan kartı özete dahil eder", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const kart = await createCard(ws.todo.id, ws.admin.id, "Yaklaşan iş");
    await prisma.card.update({
      where: { id: kart.id },
      data: { dueDate: new Date(Date.now() + GUN), assignees: { create: { userId: ws.member.id } } },
    });

    const ozet = await digestService.buildDigest(ws.member.id);
    expect(ozet.dueSoon).toHaveLength(1);
    expect(ozet.dueSoon[0].title).toBe("Yaklaşan iş");
    expect(digestService.isEmpty(ozet)).toBe(false);
  }, 60000);

  it("3 günden uzak teslim tarihini dahil etmez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const kart = await createCard(ws.todo.id, ws.admin.id, "Uzak iş");
    await prisma.card.update({
      where: { id: kart.id },
      data: { dueDate: new Date(Date.now() + 10 * GUN), assignees: { create: { userId: ws.member.id } } },
    });

    const ozet = await digestService.buildDigest(ws.member.id);
    expect(ozet.dueSoon).toHaveLength(0);
  }, 60000);

  it("son 24 saatte atanan kartı özete dahil eder", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const kart = await createCard(ws.todo.id, ws.admin.id, "Yeni atanan");
    await prisma.notification.create({
      data: { userId: ws.member.id, type: "ASSIGNED", message: "test", cardId: kart.id },
    });

    const ozet = await digestService.buildDigest(ws.member.id);
    expect(ozet.newlyAssigned.map((c) => c.title)).toContain("Yeni atanan");
  }, 60000);

  it("hiçbir şey yoksa boş sayılır", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const ozet = await digestService.buildDigest(ws.outsider.id);
    expect(digestService.isEmpty(ozet)).toBe(true);
  });
});

describe("günlük özet - bugunMu", () => {
  it("aynı UTC gün için true döner", () => {
    const now = new Date("2026-08-12T15:00:00.000Z");
    const sabah = new Date("2026-08-12T02:00:00.000Z");
    expect(digestService.bugunMu(sabah, now)).toBe(true);
  });

  it("farklı gün için false döner", () => {
    const now = new Date("2026-08-12T15:00:00.000Z");
    const dun = new Date("2026-08-11T23:00:00.000Z");
    expect(digestService.bugunMu(dun, now)).toBe(false);
  });

  it("null için false döner", () => {
    expect(digestService.bugunMu(null, new Date())).toBe(false);
  });
});
