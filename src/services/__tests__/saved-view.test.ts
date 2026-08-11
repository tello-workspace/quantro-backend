import { describe, it, expect, afterAll } from "vitest";
import * as savedViewService from "@/services/saved-view.service";
import { ForbiddenError } from "@/utils/errors";
import { createWorkspace, cleanup } from "@/test/fixtures";

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

describe("kaydedilmis gorunumler (saved views)", () => {
  it("ozel gorunumu sadece sahibi gorur, paylasilani herkes gorur", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const ozel = await savedViewService.createSavedView(
      ws.project.id,
      { name: "Bana atananlar", filters: { assigneeIds: [ws.admin.id] } },
      ws.admin.id,
    );
    const paylasilan = await savedViewService.createSavedView(
      ws.project.id,
      { name: "Bu haftaki gecikenler", filters: { priorities: ["URGENT", "HIGH"] }, isShared: true },
      ws.admin.id,
    );

    const adminGorenler = await savedViewService.listSavedViews(ws.project.id, ws.admin.id);
    expect(adminGorenler.map((v) => v.id).sort()).toEqual([ozel.id, paylasilan.id].sort());

    const uyeGorenler = await savedViewService.listSavedViews(ws.project.id, ws.member.id);
    expect(uyeGorenler.map((v) => v.id)).toEqual([paylasilan.id]);
  });

  it("sadece sahibi silebilir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const view = await savedViewService.createSavedView(
      ws.project.id,
      { name: "Paylasilan görünüm", filters: {}, isShared: true },
      ws.admin.id,
    );

    await expect(savedViewService.deleteSavedView(view.id, ws.member.id)).rejects.toThrow(ForbiddenError);

    await savedViewService.deleteSavedView(view.id, ws.admin.id);
    const kalanlar = await savedViewService.listSavedViews(ws.project.id, ws.admin.id);
    expect(kalanlar).toHaveLength(0);
  });

  it("organizasyon disindaki kullanici gorunum olusturamaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await expect(
      savedViewService.createSavedView(ws.project.id, { name: "x", filters: {} }, ws.outsider.id),
    ).rejects.toThrow(ForbiddenError);
  });
});
