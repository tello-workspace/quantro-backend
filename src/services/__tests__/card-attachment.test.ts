import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";
import * as attachmentService from "@/services/card-attachment.service";
import { NotFoundError, ForbiddenError, AppError } from "@/utils/errors";

function fakeFile(overrides: Partial<{ name: string; type: string; size: number }> = {}) {
  return {
    name: overrides.name ?? "test.png",
    type: overrides.type ?? "image/png",
    size: overrides.size ?? 1024,
    buffer: Buffer.from("fake-file-content"),
  };
}

describe("card-attachment.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("outsider karta erisemez (listeleme)", async () => {
    const { outsider, org, todo, admin } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, outsider.id);
    const card = await createCard(todo.id, admin.id);

    await expect(attachmentService.listAttachments(card.id, outsider.id)).rejects.toThrow(ForbiddenError);
  });

  it("olmayan kart icin NotFoundError firlatir", async () => {
    const { member, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(member.id);

    await expect(attachmentService.listAttachments("olmayan-kart-id", member.id)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("10MB'dan buyuk dosyayi reddeder", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const card = await createCard(todo.id, admin.id);

    await expect(
      attachmentService.uploadAttachment(card.id, admin.id, fakeFile({ size: 11 * 1024 * 1024 })),
    ).rejects.toThrow(AppError);
  });

  it("desteklenmeyen dosya turunu reddeder", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const card = await createCard(todo.id, admin.id);

    await expect(
      attachmentService.uploadAttachment(card.id, admin.id, fakeFile({ type: "application/x-msdownload" })),
    ).rejects.toThrow(AppError);
  });

  it("outsider yukleyemez (yetki kontrolu dosya kontrolunden once calisir)", async () => {
    const { outsider, org, todo, admin } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, outsider.id);
    const card = await createCard(todo.id, admin.id);

    await expect(attachmentService.uploadAttachment(card.id, outsider.id, fakeFile())).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("olmayan eki silmeye calisinca NotFoundError firlatir", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const card = await createCard(todo.id, admin.id);

    await expect(
      attachmentService.deleteAttachment(card.id, "olmayan-ek-id", admin.id),
    ).rejects.toThrow(NotFoundError);
  });
});
