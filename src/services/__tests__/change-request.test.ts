import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as changeRequestService from "@/services/change-request.service";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";
import { prisma } from "@/lib/prisma";

// Tello'nun ozgun mekanizmasi: uye yapisal degisikligi dogrudan yapamaz,
// talep acar; admin onaylayinca sistem uygular, reddedince veri atilir.
// Bu akis bozulursa ya uyeler onaysiz degisiklik yapar ya da onaylanan
// talepler sessizce hicbir sey yapmaz — ikisi de sessiz veri bozulmasi.
describe("change request onay akisi", () => {
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

  it("admin dogrudan talep olusturamaz (zaten dogrudan yapabiliyor)", async () => {
    const card = await createCard(ws.todo.id, ws.admin.id);
    await expect(
      changeRequestService.createRequest(
        {
          type: "CARD_UPDATE",
          targetCardId: card.id,
          payload: { title: "Admin talebi" },
        },
        ws.admin.id,
      ),
    ).rejects.toThrow(/admin/i);
  });

  it("uye CARD_UPDATE talebi olusturabilir, PENDING olarak baslar", async () => {
    const card = await createCard(ws.todo.id, ws.admin.id);
    const request = await changeRequestService.createRequest(
      {
        type: "CARD_UPDATE",
        targetCardId: card.id,
        payload: { title: "Uyenin onerdigi baslik" },
      },
      ws.member.id,
    );

    expect(request.status).toBe("PENDING");
    expect(request.requestedById).toBe(ws.member.id);

    // Onaylanmadan kartin gercek hali DEGISMEMIS olmali
    const unchanged = await prisma.card.findUnique({ where: { id: card.id } });
    expect(unchanged?.title).toBe(card.title);
  });

  it("organizasyon disindaki kullanici talep olusturamaz", async () => {
    const card = await createCard(ws.todo.id, ws.admin.id);
    await expect(
      changeRequestService.createRequest(
        { type: "CARD_UPDATE", targetCardId: card.id, payload: { title: "x" } },
        ws.outsider.id,
      ),
    ).rejects.toThrow(/erişim|erisim/i);
  });

  it("uye kendi talebini onaylayamaz/reddedemez", async () => {
    const card = await createCard(ws.todo.id, ws.admin.id);
    const request = await changeRequestService.createRequest(
      { type: "CARD_UPDATE", targetCardId: card.id, payload: { title: "Yeni" } },
      ws.member.id,
    );

    await expect(
      changeRequestService.approveRequest(request.id, ws.member.id),
    ).rejects.toThrow(/admin/i);
  });

  it("admin onaylayinca payload GERCEKTEN uygulanir", async () => {
    const card = await createCard(ws.todo.id, ws.admin.id);
    const request = await changeRequestService.createRequest(
      {
        type: "CARD_UPDATE",
        targetCardId: card.id,
        payload: { title: "Onaylanmis baslik", priority: "HIGH" },
      },
      ws.member.id,
    );

    const approved = await changeRequestService.approveRequest(request.id, ws.admin.id);
    expect(approved.status).toBe("APPROVED");
    expect(approved.reviewedById).toBe(ws.admin.id);

    const updatedCard = await prisma.card.findUnique({ where: { id: card.id } });
    expect(updatedCard?.title).toBe("Onaylanmis baslik");
    expect(updatedCard?.priority).toBe("HIGH");
  });

  it("admin reddedince payload UYGULANMAZ", async () => {
    const card = await createCard(ws.todo.id, ws.admin.id);
    const originalTitle = card.title;
    const request = await changeRequestService.createRequest(
      { type: "CARD_UPDATE", targetCardId: card.id, payload: { title: "Reddedilecek baslik" } },
      ws.member.id,
    );

    const rejected = await changeRequestService.rejectRequest(
      request.id,
      ws.admin.id,
      "Uygun degil",
    );
    expect(rejected.status).toBe("REJECTED");

    const untouchedCard = await prisma.card.findUnique({ where: { id: card.id } });
    expect(untouchedCard?.title).toBe(originalTitle);
  });

  it("zaten sonuclanmis talep tekrar onaylanamaz", async () => {
    const card = await createCard(ws.todo.id, ws.admin.id);
    const request = await changeRequestService.createRequest(
      { type: "CARD_UPDATE", targetCardId: card.id, payload: { title: "Bir kere" } },
      ws.member.id,
    );
    await changeRequestService.approveRequest(request.id, ws.admin.id);

    await expect(
      changeRequestService.approveRequest(request.id, ws.admin.id),
    ).rejects.toThrow(/sonuçlandırılmış|sonuclandirilmis/i);
  });

  it("uye listede sadece kendi taleplerini gorur, admin hepsini gorur", async () => {
    const card1 = await createCard(ws.todo.id, ws.admin.id);
    const card2 = await createCard(ws.todo.id, ws.admin.id);

    await changeRequestService.createRequest(
      { type: "CARD_UPDATE", targetCardId: card1.id, payload: { title: "Uye A" } },
      ws.member.id,
    );

    const memberView = await changeRequestService.listRequests(
      ws.org.id,
      { limit: 50 },
      ws.member.id,
    );
    expect(memberView.every((r) => r.requestedById === ws.member.id)).toBe(true);

    const adminView = await changeRequestService.listRequests(
      ws.org.id,
      { limit: 50 },
      ws.admin.id,
    );
    expect(adminView.length).toBeGreaterThanOrEqual(memberView.length);

    void card2;
  });
});
