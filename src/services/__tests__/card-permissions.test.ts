import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as cardService from "@/services/card.service";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";

// Projenin en kritik is kurali: yapisal degisiklikler ADMIN'e ait, uye
// karti sadece TASIYABILIR. Bu matris bozulursa uyeler baskasinin isini
// sessizce degistirebilir hale gelir; UI tarafi da buna guvendigi icin
// kural sunucuda tutulmali.
describe("kart yetki matrisi", () => {
  let ws: Awaited<ReturnType<typeof createWorkspace>>;

  beforeAll(async () => {
    ws = await createWorkspace();
  });

  afterAll(async () => {
    await cleanup({
      orgIds: [ws.org.id],
      userIds: [ws.admin.id, ws.member.id, ws.outsider.id],
    });
  });

  describe("ADMIN", () => {
    it("kart olusturabilir", async () => {
      const card = await cardService.createCard(
        ws.todo.id,
        { title: "Admin karti" },
        ws.admin.id,
      );
      expect(card.title).toBe("Admin karti");
    });

    it("kart icerigini duzenleyebilir", async () => {
      const card = await createCard(ws.todo.id, ws.admin.id);
      const updated = await cardService.updateCard(
        card.id,
        { title: "Yeni baslik", priority: "HIGH" },
        ws.admin.id,
      );
      expect(updated.title).toBe("Yeni baslik");
      expect(updated.priority).toBe("HIGH");
    });

    it("gorev atayabilir", async () => {
      const card = await createCard(ws.todo.id, ws.admin.id);
      const updated = await cardService.updateCard(
        card.id,
        { assigneeIds: [ws.member.id] },
        ws.admin.id,
      );
      expect(updated.assignees.map((a) => a.userId)).toContain(ws.member.id);
    });
  });

  describe("MEMBER", () => {
    it("karti tasiyabilir (kanban akisi bozulmasin diye izinli)", async () => {
      const card = await createCard(ws.todo.id, ws.admin.id);
      const updated = await cardService.updateCard(
        card.id,
        { columnId: ws.done.id },
        ws.member.id,
      );
      expect(updated.columnId).toBe(ws.done.id);
    });

    it("kart OLUSTURAMAZ", async () => {
      await expect(
        cardService.createCard(ws.todo.id, { title: "Uye karti" }, ws.member.id),
      ).rejects.toThrow(/admin/i);
    });

    it("kart icerigini DUZENLEYEMEZ", async () => {
      const card = await createCard(ws.todo.id, ws.admin.id);
      await expect(
        cardService.updateCard(card.id, { title: "Uye degistirdi" }, ws.member.id),
      ).rejects.toThrow(/admin/i);
    });

    it("gorev ATAYAMAZ", async () => {
      const card = await createCard(ws.todo.id, ws.admin.id);
      await expect(
        cardService.updateCard(card.id, { assigneeIds: [ws.member.id] }, ws.member.id),
      ).rejects.toThrow(/admin/i);
    });
  });

  describe("ORGANIZASYON DISINDAKI KULLANICI", () => {
    it("karti goremez", async () => {
      const card = await createCard(ws.todo.id, ws.admin.id);
      await expect(cardService.getCardById(card.id, ws.outsider.id)).rejects.toThrow(
        /erişim|erisim/i,
      );
    });

    it("karti tasiyamaz", async () => {
      const card = await createCard(ws.todo.id, ws.admin.id);
      await expect(
        cardService.updateCard(card.id, { columnId: ws.done.id }, ws.outsider.id),
      ).rejects.toThrow(/erişim|erisim/i);
    });

    it("kart olusturamaz", async () => {
      await expect(
        cardService.createCard(ws.todo.id, { title: "Yabanci" }, ws.outsider.id),
      ).rejects.toThrow(/erişim|erisim/i);
    });
  });
});
