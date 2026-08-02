import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";
import { prisma } from "@/lib/prisma";
import * as automationService from "@/services/automation.service";

// Otomasyon MOTORU testleri (RBAC degil - kurallarin gercekten calistigini
// dogrular). runRulesForTrigger cagrilir, executeAction'in yan etkileri
// (tasima, etiket, atama) DB'de kontrol edilir.
//
// Not: runRulesForTrigger fire-and-forget degil ama hatalari tek tek yutar
// (her kural try/catch icinde). Bu yuzden basarisiz kurallar throw etmez,
// sadece DB'de aksiyon gozlenmez.

describe("automation.service motoru", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("CARD_CREATED tetikleyicisiyle karti hedef sutuna tasir", async () => {
    const { admin, org, todo, done } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const projectId = (await prisma.project.findFirst({ where: { organizationId: org.id } }))!.id;

    // Kural: kart olusunca done sutununa tasi
    await automationService.createAutomationRule(
      projectId,
      { name: "Otomatik tamamla", trigger: "CARD_CREATED", actionType: "MOVE_TO_COLUMN", actionColumnId: done.id },
      admin.id,
    );

    // Bir kart olustur ve CARD_CREATED kuralini calistir
    const card = await createCard(todo.id, admin.id, "Kart");
    await automationService.runRulesForTrigger({
      projectId,
      trigger: "CARD_CREATED",
      cardId: card.id,
      columnId: todo.id,
    });

    const updated = await prisma.card.findUnique({ where: { id: card.id }, select: { columnId: true } });
    expect(updated?.columnId).toBe(done.id);
  });

  it("conditionPriority eslesmezse aksiyon calismaz", async () => {
    const { admin, org, todo, done } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const projectId = (await prisma.project.findFirst({ where: { organizationId: org.id } }))!.id;

    // Kural: sadece URGENT kartlar done'a tasinsin
    await automationService.createAutomationRule(
      projectId,
      {
        name: "URGENT'i tamamla",
        trigger: "CARD_CREATED",
        actionType: "MOVE_TO_COLUMN",
        actionColumnId: done.id,
        conditionPriority: "URGENT",
      },
      admin.id,
    );

    // MEDIUM oncelikli kart -> tasinmamali
    const card = await prisma.card.create({
      data: { columnId: todo.id, title: "Normal kart", creatorId: admin.id, position: 1, priority: "MEDIUM" },
    });
    await automationService.runRulesForTrigger({ projectId, trigger: "CARD_CREATED", cardId: card.id, columnId: todo.id });

    const after = await prisma.card.findUnique({ where: { id: card.id }, select: { columnId: true } });
    expect(after?.columnId).toBe(todo.id);
  });

  it("conditionPriority eslesirse aksiyon calisir", async () => {
    const { admin, org, todo, done } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const projectId = (await prisma.project.findFirst({ where: { organizationId: org.id } }))!.id;

    await automationService.createAutomationRule(
      projectId,
      {
        name: "URGENT'i tamamla",
        trigger: "CARD_CREATED",
        actionType: "MOVE_TO_COLUMN",
        actionColumnId: done.id,
        conditionPriority: "URGENT",
      },
      admin.id,
    );

    const card = await prisma.card.create({
      data: { columnId: todo.id, title: "Acil kart", creatorId: admin.id, position: 1, priority: "URGENT" },
    });
    await automationService.runRulesForTrigger({ projectId, trigger: "CARD_CREATED", cardId: card.id, columnId: todo.id });

    const after = await prisma.card.findUnique({ where: { id: card.id }, select: { columnId: true } });
    expect(after?.columnId).toBe(done.id);
  });

  it("ADD_LABEL aksiyonu etiket ekler", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const projectId = (await prisma.project.findFirst({ where: { organizationId: org.id } }))!.id;

    const label = await prisma.label.create({
      data: { projectId, name: "Bug", color: "#EF4444" },
    });

    await automationService.createAutomationRule(
      projectId,
      { name: "Bug etiketi", trigger: "CARD_CREATED", actionType: "ADD_LABEL", actionLabelId: label.id },
      admin.id,
    );

    const card = await createCard(todo.id, admin.id, "Buglu kart");
    await automationService.runRulesForTrigger({
      projectId,
      trigger: "CARD_CREATED",
      cardId: card.id,
      columnId: todo.id,
    });

    const cardLabels = await prisma.cardLabel.findMany({ where: { cardId: card.id } });
    expect(cardLabels.some((cl) => cl.labelId === label.id)).toBe(true);
  });
});
