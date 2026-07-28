import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as searchService from "@/services/search.service";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";
import { prisma } from "@/lib/prisma";

describe("organizasyon geneli arama", () => {
  let ws: Awaited<ReturnType<typeof createWorkspace>>;
  let secondProjectId: string;

  beforeAll(async () => {
    ws = await createWorkspace();
    const secondProject = await prisma.project.create({
      data: { name: "Ikinci Proje", organizationId: ws.org.id, ownerId: ws.admin.id },
    });
    secondProjectId = secondProject.id;
    const secondColumn = await prisma.column.create({
      data: { projectId: secondProjectId, name: "Backlog", position: 1 },
    });

    await createCard(ws.todo.id, ws.admin.id, "Login ekranında hata var");
    await createCard(secondColumn.id, ws.admin.id, "Ödeme sayfası tasarımı");
    await createCard(ws.todo.id, ws.admin.id, "Alakasız görev");
  });

  afterAll(async () => {
    await cleanup({
      orgIds: [ws.org.id],
      userIds: [ws.admin.id, ws.member.id, ws.outsider.id],
    });
  });

  it("baslikta gecen kelimeyi FARKLI projeler dahil bulur", async () => {
    const result = await searchService.searchOrganization(ws.org.id, ws.member.id, "ekranında");
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].title).toContain("Login ekranında");
  });

  it("ikinci projedeki kart da sonucta cikar (org genelinde arama)", async () => {
    const result = await searchService.searchOrganization(ws.org.id, ws.member.id, "ödeme");
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].projectId).toBe(secondProjectId);
  });

  it("buyuk/kucuk harf duyarsiz arar", async () => {
    const result = await searchService.searchOrganization(ws.org.id, ws.member.id, "ekranında hata");
    expect(result.cards.some((c) => c.title.includes("Login"))).toBe(true);
  });

  it("Turkce aksan duyarsiz arar (odeme -> Ödeme)", async () => {
    const result = await searchService.searchOrganization(ws.org.id, ws.member.id, "odeme");
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].title).toContain("Ödeme");
  });

  it("eslesme yoksa bos liste doner", async () => {
    const result = await searchService.searchOrganization(ws.org.id, ws.member.id, "bulunmayan-kelime-xyz");
    expect(result.cards).toEqual([]);
  });

  it("organizasyon disindaki kullanici arayamaz", async () => {
    await expect(
      searchService.searchOrganization(ws.org.id, ws.outsider.id, "login"),
    ).rejects.toThrow(/erişim|erisim/i);
  });
});
