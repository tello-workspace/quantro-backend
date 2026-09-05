import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, createCard, cleanup, uniq } from "@/test/fixtures";
import { prisma } from "@/lib/prisma";
import * as automationService from "@/services/automation.service";
import { ValidationError } from "@/utils/errors";

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
      data: { columnId: todo.id, number: 901, title: "Normal kart", creatorId: admin.id, position: 1, priority: "MEDIUM" },
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
      data: { columnId: todo.id, number: 902, title: "Acil kart", creatorId: admin.id, position: 1, priority: "URGENT" },
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

  // Tasima sonrasi position'in hedef sutunun SONUNA alindigini dogrular.
  // Eski davranista kart eski sutundaki position'iyla geliyordu ve hedefte
  // mevcut bir kartla ayni degere dusup siralamayi kararsiz birakiyordu;
  // testsiz kaldigi surece bu regresyon sessizce geri gelebilir.
  it("MOVE_TO_COLUMN karti hedef sutunun sonuna yerlestirir", async () => {
    const { admin, org, project, todo, done } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    // Hedef sutunda zaten position=5 olan bir kart var
    const mevcut = await createCard(done.id, admin.id, "Zaten bitmis kart");
    await prisma.card.update({ where: { id: mevcut.id }, data: { position: 5 } });

    await automationService.createAutomationRule(
      project.id,
      { name: "Otomatik tamamla", trigger: "CARD_CREATED", actionType: "MOVE_TO_COLUMN", actionColumnId: done.id },
      admin.id,
    );

    const card = await createCard(todo.id, admin.id, "Yeni kart");
    await automationService.runRulesForTrigger({
      projectId: project.id,
      trigger: "CARD_CREATED",
      cardId: card.id,
      columnId: todo.id,
    });

    const after = await prisma.card.findUnique({
      where: { id: card.id },
      select: { columnId: true, position: true },
    });
    expect(after?.columnId).toBe(done.id);
    expect(after?.position).toBe(6);
  });

  // Kural kurulurken hedeflerin AYNI projeye ait olmasi sarti (kiracı sinirlari).
  // Bu dogrulama olmadan admin, govdeye baska bir projenin sutun id'sini yazip
  // kartlari o panoya tasitabiliyordu.
  it("baska projenin sutunu actionColumnId olarak kabul edilmez", async () => {
    const { admin, org, project } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const digerProje = await prisma.project.create({
      data: { name: uniq("project"), key: "TS2", organizationId: org.id, ownerId: admin.id },
    });
    const digerSutun = await prisma.column.create({
      data: { projectId: digerProje.id, name: "Yabanci sutun", position: 1 },
    });

    await expect(
      automationService.createAutomationRule(
        project.id,
        {
          name: "Yanlis hedef",
          trigger: "CARD_CREATED",
          actionType: "MOVE_TO_COLUMN",
          actionColumnId: digerSutun.id,
        },
        admin.id,
      ),
    ).rejects.toThrow(ValidationError);
  });

  // ASSIGN_USER icin actionUserId'nin projenin organizasyonuna uye olmasi sarti -
  // manuel atamadaki validateAssignees ile ayni kural. Testsiz kalirsa org disi
  // birine kart atanabilir ve kart basligi bildirim/ozet e-postasiyla disari cikar.
  it("org uyesi olmayan kisi ASSIGN_USER hedefi olamaz", async () => {
    const { admin, outsider, org, project } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, outsider.id);

    await expect(
      automationService.createAutomationRule(
        project.id,
        { name: "Disariya ata", trigger: "CARD_CREATED", actionType: "ASSIGN_USER", actionUserId: outsider.id },
        admin.id,
      ),
    ).rejects.toThrow(ValidationError);
  });

  // Uyelik kural KURULDUKTAN sonra da kaybolabilir; motor calisma aninda
  // tekrar dogrulamazsa organizasyondan cikarilmis kisi kart almaya devam eder.
  it("kural kurulduktan sonra org'dan cikarilan kisiye atama yapilmaz", async () => {
    const { admin, member, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    await automationService.createAutomationRule(
      project.id,
      { name: "Uyeye ata", trigger: "CARD_CREATED", actionType: "ASSIGN_USER", actionUserId: member.id },
      admin.id,
    );

    // Kural kuruldu, sonra kisi organizasyondan cikarildi
    await prisma.organizationMember.deleteMany({ where: { organizationId: org.id, userId: member.id } });

    const card = await createCard(todo.id, admin.id, "Atamasiz kalmali");
    await automationService.runRulesForTrigger({
      projectId: project.id,
      trigger: "CARD_CREATED",
      cardId: card.id,
      columnId: todo.id,
    });

    const atamalar = await prisma.cardAssignee.findMany({ where: { cardId: card.id } });
    expect(atamalar).toHaveLength(0);
  });

  // SEND_NOTIFICATION'in tekrar korumasi: CARD_DUE_SOON kurali gece taramasinda
  // ayni karti her gece (ve ayni gece birden fazla kez) yeniden isliyor. Okunmamis
  // ayni bildirim varsa yenisi uretilmemeli, yoksa zil ayni mesajla doluyor.
  //
  // Not: tarama fonksiyonu (runScheduledAndDueSoonAutomations) TUM projelerin
  // kurallarini calistirdigi icin burada cagrilmiyor - testler paylasilan takim
  // veritabanina bagli (src/test/setup.ts). Ayni dal runRulesForTrigger ile
  // proje kapsaminda tetikleniyor.
  it("CARD_DUE_SOON bildirimi ikinci tetiklemede tekrarlanmaz", async () => {
    const { admin, org, project, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const mesaj = "Teslim tarihi yaklasiyor";
    await automationService.createAutomationRule(
      project.id,
      {
        name: "Teslim hatirlatmasi",
        trigger: "CARD_DUE_SOON",
        actionType: "SEND_NOTIFICATION",
        actionUserId: admin.id,
        actionMessage: mesaj,
        dueSoonDays: 7,
      },
      admin.id,
    );

    // Teslim tarihi 3 gun sonra olan, henuz Done olmayan kart
    const card = await createCard(todo.id, admin.id, "Yaklasan kart");
    await prisma.card.update({
      where: { id: card.id },
      data: { dueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) },
    });

    const tetikle = () =>
      automationService.runRulesForTrigger({
        projectId: project.id,
        trigger: "CARD_DUE_SOON",
        cardId: card.id,
        columnId: todo.id,
      });
    await tetikle();
    await tetikle();

    const bildirimler = await prisma.notification.findMany({
      where: { userId: admin.id, cardId: card.id, message: mesaj },
    });
    expect(bildirimler).toHaveLength(1);
  });
});
