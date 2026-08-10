import { describe, it, expect, afterAll } from "vitest";
import * as cardService from "@/services/card.service";
import { ForbiddenError } from "@/utils/errors";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

describe("kart arsivi - proje genelinde arsiv ekrani", () => {
  it("kart arsivlenince kim arsivledigi kaydedilir, geri yuklenince temizlenir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const card = await createCard(ws.todo.id, ws.admin.id, "Arsivlenecek kart");

    await cardService.archiveCard(card.id, ws.member.id);
    let arsivdekiler = await cardService.getArchivedCardsForProject(ws.project.id, ws.admin.id);
    expect(arsivdekiler).toHaveLength(1);
    expect(arsivdekiler[0].id).toBe(card.id);
    expect(arsivdekiler[0].archivedBy?.id).toBe(ws.member.id);
    expect(arsivdekiler[0].column.id).toBe(ws.todo.id);

    await cardService.restoreCard(card.id, ws.admin.id);
    arsivdekiler = await cardService.getArchivedCardsForProject(ws.project.id, ws.admin.id);
    expect(arsivdekiler).toHaveLength(0);
  });

  it("birden fazla kolondaki arsivlenmis kartlari tek listede, en yeniden eskiye dondurur", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const eski = await createCard(ws.todo.id, ws.admin.id, "Once arsivlenen");
    await cardService.archiveCard(eski.id, ws.admin.id);

    const yeni = await createCard(ws.done.id, ws.admin.id, "Sonra arsivlenen");
    await cardService.archiveCard(yeni.id, ws.admin.id);

    const arsivdekiler = await cardService.getArchivedCardsForProject(ws.project.id, ws.admin.id);
    expect(arsivdekiler.map((c) => c.id)).toEqual([yeni.id, eski.id]);
  });

  it("organizasyon uyesi olmayan kullanici arsivi goremez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await expect(
      cardService.getArchivedCardsForProject(ws.project.id, ws.outsider.id)
    ).rejects.toThrow(ForbiddenError);
  });
});
