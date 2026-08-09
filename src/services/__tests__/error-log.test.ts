import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createWorkspace, cleanup } from "@/test/fixtures";
import * as errorLogService from "@/services/error-log.service";
import { ForbiddenError } from "@/utils/errors";

describe("error-log.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("org admin gorebilir", async () => {
    const { admin, member, outsider, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id, outsider.id);

    // Kayit org'a atfedilir - yeni kapsam geregi admin yalnizca kendi org'unun
    // kayitlarini gorebilir.
    const log = await prisma.errorLog.create({
      data: {
        message: "test hatasi",
        method: "GET",
        path: "/api/test",
        organizationId: org.id,
      },
    });

    try {
      const logs = await errorLogService.listErrorLogs(admin.id, 10);
      expect(logs.some((l) => l.id === log.id)).toBe(true);
    } finally {
      await prisma.errorLog.delete({ where: { id: log.id } });
    }
  });

  it("normal uye goremez", async () => {
    const { member, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(member.id);

    await expect(errorLogService.listErrorLogs(member.id, 10)).rejects.toThrow(ForbiddenError);
  });

  it("hicbir organizasyonu olmayan kullanici goremez", async () => {
    const { outsider, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(outsider.id);

    await expect(errorLogService.listErrorLogs(outsider.id, 10)).rejects.toThrow(ForbiddenError);
  });
});
