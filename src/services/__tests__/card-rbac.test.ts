import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, cleanup } from "@/test/fixtures";
import * as cardService from "@/services/card.service";
import { ForbiddenError, NotFoundError } from "@/utils/errors";

// Kart olusturma/gorme/silme yetki kontrolu:
// - Sadece ADMIN kart olusturabilir (MEMBER => ForbiddenError)
// - Outsider projeye hic erisemez (ForbiddenError)
// - Olmayan kolon/kart => NotFoundError
// - Atanan kullaniciya ASSIGNED bildirimi gider
//
// card.service.ts createCard icin "Sadece adminler kart olusturabilir" der;
// MEMBER ise frontend'te degisiklik talebi (change request) akisina yonlendirilir.

describe("card.service RBAC", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("MEMBER kart olusturamaz (ForbiddenError)", async () => {
    const { member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(member.id);

    await expect(
      cardService.createCard(todo.id, { title: "Test" }, member.id),
    ).rejects.toThrow(ForbiddenError);
  });

  it("ADMIN kart olusturabilir", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const card = await cardService.createCard(todo.id, { title: "Test kart" }, admin.id);
    expect(card).toMatchObject({ title: "Test kart", columnId: todo.id, creatorId: admin.id });
  });

  it("outsider kart olusturamaz (ForbiddenError)", async () => {
    const { outsider, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(outsider.id);

    await expect(
      cardService.createCard(todo.id, { title: "Test" }, outsider.id),
    ).rejects.toThrow(ForbiddenError);
  });

  it("olmayan kolon icin NotFoundError firlatir", async () => {
    const { admin, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    await expect(
      cardService.createCard("olmayan-kolon", { title: "Test" }, admin.id),
    ).rejects.toThrow(NotFoundError);
  });

  it("olmayan karta erisimde NotFoundError firlatir (getCardById)", async () => {
    const { admin, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    await expect(cardService.getCardById("olmayan-kart", admin.id)).rejects.toThrow(NotFoundError);
  });

  it("atana ASSIGNED bildirimi olusturur", async () => {
    const { admin, member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    const card = await cardService.createCard(todo.id, { title: "Atamali kart", assigneeIds: [member.id] }, admin.id);

    // Bildirim DB'de olusturuldu mu? (notification.service prisma.notification.create kullaniyor)
    const { prisma } = await import("@/lib/prisma");
    const notification = await prisma.notification.findFirst({
      where: { userId: member.id, type: "ASSIGNED", cardId: card.id },
    });
    expect(notification).not.toBeNull();
  });
});
