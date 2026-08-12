import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";
import * as automationService from "@/services/automation.service";
import { ForbiddenError, NotFoundError } from "@/utils/errors";

// Otomasyon kurallari RBAC: sadece organizasyon ADMIN'i yonetebilir.
// MEMBER ve outsider => ForbiddenError (403), mevcut olmayan proje => NotFound.
//
// Not: Bu testler createWorkspace fixture'ini kullanir (admin + member +
// outsider + org + project). Kurallar gercekten calistirilmaz, sadece
// yetki kontrolu test edilir - dolayisiyla aksiyon/trigger enum'lari
// sadece schema'ya uygun herhangi bir deger olabilir.

const VALID_RULE = {
  name: "Test kurali",
  trigger: "CARD_CREATED" as const,
  actionType: "ADD_LABEL" as const,
};

describe("automation.service RBAC", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("listeleme: MEMBER yetkisiz (ForbiddenError)", async () => {
    const { member, org, project } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(member.id);

    await expect(automationService.listAutomationRules(project.id, member.id)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("listeleme: outsider yetkisiz (ForbiddenError)", async () => {
    const { outsider, org, project } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(outsider.id);

    await expect(automationService.listAutomationRules(project.id, outsider.id)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("listeleme: ADMIN yetkili", async () => {
    const { admin, org, project } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const rules = await automationService.listAutomationRules(project.id, admin.id);
    expect(Array.isArray(rules)).toBe(true);
  });

  it("olusturma: MEMBER yetkisiz (ForbiddenError)", async () => {
    const { member, org, project } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(member.id);

    await expect(
      automationService.createAutomationRule(project.id, VALID_RULE, member.id),
    ).rejects.toThrow(ForbiddenError);
  });

  it("olusturma: ADMIN yetkili", async () => {
    const { admin, org, project } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const rule = await automationService.createAutomationRule(project.id, VALID_RULE, admin.id);
    expect(rule).toMatchObject({ name: "Test kurali", projectId: project.id });
  });

  it("guncelleme: MEMBER yetkisiz (ForbiddenError)", async () => {
    const { admin, member, org, project } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    const rule = await automationService.createAutomationRule(project.id, VALID_RULE, admin.id);
    await expect(
      automationService.updateAutomationRule(rule.id, { name: "X" }, member.id),
    ).rejects.toThrow(ForbiddenError);
  });

  it("silme: MEMBER yetkisiz (ForbiddenError)", async () => {
    const { admin, member, org, project } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    const rule = await automationService.createAutomationRule(project.id, VALID_RULE, admin.id);
    await expect(automationService.deleteAutomationRule(rule.id, member.id)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("olmayan proje icin NotFoundError firlatir", async () => {
    const { member, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(member.id);

    await expect(automationService.listAutomationRules("olmayan-proje", member.id)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("automation.service - kart tekrarı (sourceCardId)", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("tekrarlanan kart yoksa null döner", async () => {
    const { admin, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const kart = await createCard(todo.id, admin.id, "Tekrarsız kart");
    const kural = await automationService.getCardRecurrence(kart.id, admin.id);
    expect(kural).toBeNull();
  });

  it("sourceCardId ile oluşturulan kural o kart için döner", async () => {
    const { admin, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const kart = await createCard(todo.id, admin.id, "Haftalık rapor");
    await automationService.createAutomationRule(
      project.id,
      {
        name: "Tekrar: Haftalık rapor",
        trigger: "SCHEDULED",
        actionType: "CREATE_CARD",
        actionColumnId: todo.id,
        actionMessage: "Haftalık rapor",
        scheduleDayOfWeek: 1,
        sourceCardId: kart.id,
      },
      admin.id,
    );

    const kural = await automationService.getCardRecurrence(kart.id, admin.id);
    expect(kural).not.toBeNull();
    expect(kural?.scheduleDayOfWeek).toBe(1);
  });

  it("başka kartın kuralını döndürmez", async () => {
    const { admin, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const kartA = await createCard(todo.id, admin.id, "A");
    const kartB = await createCard(todo.id, admin.id, "B");
    await automationService.createAutomationRule(
      project.id,
      {
        name: "Tekrar: A",
        trigger: "SCHEDULED",
        actionType: "CREATE_CARD",
        actionColumnId: todo.id,
        actionMessage: "A",
        sourceCardId: kartA.id,
      },
      admin.id,
    );

    const kural = await automationService.getCardRecurrence(kartB.id, admin.id);
    expect(kural).toBeNull();
  });

  it("üyesi olmadığı projedeki kartın tekrar durumunu göremez", async () => {
    const { admin, outsider, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, outsider.id);

    const kart = await createCard(todo.id, admin.id, "Gizli kart");
    await expect(automationService.getCardRecurrence(kart.id, outsider.id)).rejects.toThrow(ForbiddenError);
  });
});
