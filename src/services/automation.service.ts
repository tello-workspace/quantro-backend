import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ValidationError } from "@/utils/errors";
import * as notificationService from "@/services/notification.service";
import { logActivity } from "@/services/activity.service";
import { notifyWatchers } from "@/services/watcher.service";
import { notifyBlockerResolved } from "@/services/dependency.service";
import { checkProjectAccess } from "@/services/access-control.service";
import { checkColumnTransitionRules } from "@/services/column-transition.service";
import { broadcastToProject, SocketEvents } from "@/server/socket";
import { allocateCardNumber } from "@/services/card-key.service";
import type { AutomationRule, AutomationTrigger } from "@prisma/client";
import type { CreateAutomationRuleInput, UpdateAutomationRuleInput } from "@/schemas/automation.schema";

// checkProjectAccess gorunurluk/GUEST kuralini da uyguluyor - PRIVATE bir
// projede org ADMIN'i bile ProjectMember degilse burada elenir (eskiden
// sadece org rolune bakildigi icin bu durumu atlıyordu).
async function checkProjectAdmin(projectId: string, userId: string) {
  const access = await checkProjectAccess(projectId, userId);
  if (access.role !== "ADMIN") throw new ForbiddenError("Otomasyon kurallarını sadece adminler yönetebilir");
}

export async function listAutomationRules(projectId: string, userId: string) {
  await checkProjectAdmin(projectId, userId);
  return prisma.automationRule.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}

// Kuralin tasidigi her yabanci anahtarin AYNI projeye ait oldugunu dogrular.
// Sema (automation.schema.ts) bu alanlari serbest string kabul ediyor ve
// checkProjectAdmin sadece URL'deki projeyi koruyor; aidiyet dogrulanmazsa
// bir admin gövdeye BASKA bir organizasyonun kolon/etiket/kart id'sini yazip
// kartlari o panoya tasitabiliyor ya da orada kart actirabiliyordu
// (card.service.ts:395'te manuel yola konan proje sinirinin otomasyon
// tarafindaki karsiligi). actionUserId icin de projenin organizasyonuna
// uyelik sart - manuel atamada validateAssignees ayni sarti koyuyor.
async function dogrulaKuralHedefleri(projectId: string, input: CreateAutomationRuleInput) {
  const proje = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  if (!proje) throw new NotFoundError("Proje");

  const kolonIdler = [input.triggerColumnId, input.actionColumnId].filter(
    (id): id is string => !!id,
  );
  const etiketIdler = [input.actionLabelId, input.conditionLabelId].filter(
    (id): id is string => !!id,
  );

  if (kolonIdler.length > 0) {
    const kolonlar = await prisma.column.findMany({
      where: { id: { in: kolonIdler }, projectId },
      select: { id: true },
    });
    const bulunan = new Set(kolonlar.map((k) => k.id));
    if (kolonIdler.some((id) => !bulunan.has(id))) {
      throw new ValidationError("Seçilen sütun bu projeye ait değil");
    }
  }

  if (etiketIdler.length > 0) {
    const etiketler = await prisma.label.findMany({
      where: { id: { in: etiketIdler }, projectId },
      select: { id: true },
    });
    const bulunan = new Set(etiketler.map((e) => e.id));
    if (etiketIdler.some((id) => !bulunan.has(id))) {
      throw new ValidationError("Seçilen etiket bu projeye ait değil");
    }
  }

  if (input.sourceCardId) {
    const kart = await prisma.card.findFirst({
      where: { id: input.sourceCardId, column: { projectId } },
      select: { id: true },
    });
    if (!kart) throw new ValidationError("Seçilen kart bu projeye ait değil");
  }

  if (input.actionUserId) {
    const uye = await prisma.organizationMember.findFirst({
      where: { organizationId: proje.organizationId, userId: input.actionUserId },
      select: { userId: true },
    });
    if (!uye) throw new ValidationError("Seçilen kişi bu organizasyonun üyesi değil");
  }
}

export async function createAutomationRule(projectId: string, input: CreateAutomationRuleInput, userId: string) {
  await checkProjectAdmin(projectId, userId);
  await dogrulaKuralHedefleri(projectId, input);

  return prisma.automationRule.create({
    data: {
      projectId,
      name: input.name,
      trigger: input.trigger,
      triggerColumnId: input.triggerColumnId,
      actionType: input.actionType,
      actionLabelId: input.actionLabelId,
      actionColumnId: input.actionColumnId,
      actionUserId: input.actionUserId,
      actionMessage: input.actionMessage,
      scheduleDayOfWeek: input.scheduleDayOfWeek,
      dueSoonDays: input.dueSoonDays,
      conditionPriority: input.conditionPriority,
      conditionLabelId: input.conditionLabelId,
      sourceCardId: input.sourceCardId,
      createdById: userId,
    },
  });
}

// Bir kartin "tekrarlaniyor mu" durumunu getirir - kart detayinda tekrar
// kontrolunun mevcut aktif kurali gostermesi icin. Goruntuleme icin proje
// uyeligi yeterli (yonetim/silme hala checkProjectAdmin'e tabi, mevcut
// updateAutomationRule/deleteAutomationRule uzerinden).
export async function getCardRecurrence(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { column: { select: { projectId: true } } },
  });
  if (!card) throw new NotFoundError("Kart");
  await checkProjectAccess(card.column.projectId, userId);

  return prisma.automationRule.findFirst({
    where: { sourceCardId: cardId, trigger: "SCHEDULED", actionType: "CREATE_CARD" },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateAutomationRule(ruleId: string, input: UpdateAutomationRuleInput, userId: string) {
  const rule = await prisma.automationRule.findUnique({ where: { id: ruleId } });
  if (!rule) throw new NotFoundError("Otomasyon kuralı");

  await checkProjectAdmin(rule.projectId, userId);

  return prisma.automationRule.update({
    where: { id: ruleId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
  });
}

export async function deleteAutomationRule(ruleId: string, userId: string) {
  const rule = await prisma.automationRule.findUnique({ where: { id: ruleId } });
  if (!rule) throw new NotFoundError("Otomasyon kuralı");

  await checkProjectAdmin(rule.projectId, userId);
  await prisma.automationRule.delete({ where: { id: ruleId } });
}

// Kural conditionPriority/conditionLabelId ile kisitlanmissa, karti bu
// kosullara gore filtreler. Ikisi de doluysa ikisi de saglanmali (VE mantigi).
// Ikisi de null ise (varsayilan) her kart eslesir - geriye donuk uyumluluk
// bunu gerektiriyor, mevcut kurallarin hicbiri kosul tanimlamadigi icin
// davranislari degismemeli.
async function cardMatchesConditions(rule: AutomationRule, cardId: string): Promise<boolean> {
  if (!rule.conditionPriority && !rule.conditionLabelId) return true;

  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: {
      priority: true,
      labels: rule.conditionLabelId ? { select: { labelId: true } } : false,
    },
  });
  if (!card) return false;

  if (rule.conditionPriority && card.priority !== rule.conditionPriority) return false;
  if (rule.conditionLabelId) {
    const hasLabel = (card.labels ?? []).some((l) => l.labelId === rule.conditionLabelId);
    if (!hasLabel) return false;
  }

  return true;
}

// ─── Calistirma motoru ──────────────────────────────────────────────
//
// card.service.ts'teki createCard/updateCard basarili olduktan SONRA
// cagrilir, fire-and-forget degil ama hatasi asil islemi bozmasin diye
// caller try/catch icinde tutuyor. Aksiyonlar birbirini TEKRAR
// tetiklemez (orn. MOVE_TO_COLUMN dogrudan DB'yi gunceller, updateCard'i
// tekrar cagirmaz) - boylece sonsuz dongu riski yapisal olarak yok.
export async function runRulesForTrigger(input: {
  projectId: string;
  trigger: AutomationTrigger;
  cardId: string;
  columnId: string;
}) {
  const rules = await prisma.automationRule.findMany({
    where: {
      projectId: input.projectId,
      trigger: input.trigger,
      isActive: true,
      OR: [{ triggerColumnId: input.columnId }, { triggerColumnId: null }],
    },
  });

  for (const rule of rules) {
    try {
      if (!(await cardMatchesConditions(rule, input.cardId))) continue;
      await executeAction(rule, input.cardId);
    } catch (error) {
      console.error(`[automation] "${rule.name}" kurali calisirken hata:`, error);
    }
  }
}

async function executeAction(rule: AutomationRule, cardId: string) {
  switch (rule.actionType) {
    case "ADD_LABEL": {
      if (!rule.actionLabelId) return;
      const label = await prisma.label.findUnique({ where: { id: rule.actionLabelId } });
      if (!label) return; // etiket silinmis - sessizce atla
      // Olusturmada aidiyet dogrulaniyor ama kural kurulduktan sonra etiket
      // baska bir projeye tasinmis olabilir; baska projenin etiketini karta
      // iliştirmek o etiketin adini/rengini disari sizdirir.
      if (label.projectId !== rule.projectId) return;
      await prisma.cardLabel.upsert({
        where: { cardId_labelId: { cardId, labelId: rule.actionLabelId } },
        create: { cardId, labelId: rule.actionLabelId },
        update: {},
      });
      return;
    }
    case "MOVE_TO_COLUMN": {
      if (!rule.actionColumnId) return;
      const column = await prisma.column.findUnique({ where: { id: rule.actionColumnId } });
      if (!column) return;
      // Kart baska bir projenin sutununa DUSMEMELI: manuel yol bunu
      // card.service.ts:395'te ValidationError ile yasakliyor, otomasyon
      // ayni sinira uymazsa kart karsi kiracinin panosunda beliriyor ve
      // kart numarasi orada cakisiyor.
      if (column.projectId !== rule.projectId) return;

      // title ve eski sutun adi da cekiliyor: asagidaki aktivite kaydi ile
      // izleyici bildirimi manuel yoldaki (card.service.ts:443-455) metinlerin
      // birebir aynisini uretebilsin diye.
      const before = await prisma.card.findUnique({
        where: { id: cardId },
        select: { columnId: true, title: true, column: { select: { name: true } } },
      });
      if (!before || before.columnId === rule.actionColumnId) return;

      // Kolon gecis kurallari otomasyona da uygulanmali: ENFORCE modunda
      // kullanicinin surukleyerek yapamayacagi gecisi otomasyonun sessizce
      // yapmasi kolon kurallarini anlamsizlastiriyordu (bloklu kart Done'a
      // dusuyordu). WARN modunda eski davranis korunuyor: tasima yapilir.
      const ihlaller = await checkColumnTransitionRules(cardId, column);
      if (ihlaller.length > 0 && column.transitionMode === "ENFORCE") {
        console.warn(
          `[automation] "${rule.name}" kurali "${column.name}" sutununun gecis kurallari nedeniyle uygulanmadi: ${ihlaller.join(", ")}`,
        );
        return;
      }

      // Hedef sutunda position yeniden hesaplanmali - eski sutundaki deger
      // oldugu gibi kalirsa kart hedefte mevcut bir kartla ayni position'a
      // dusuyor ve siralama kararsiz hale geliyor (manuel yol da ayni
      // duzeltmeyi card.service.ts:453'te yapiyor).
      const sonKart = await prisma.card.findFirst({
        where: { columnId: rule.actionColumnId },
        orderBy: { position: "desc" },
        select: { position: true },
      });

      const updated = await prisma.card.update({
        where: { id: cardId },
        data: {
          columnId: rule.actionColumnId,
          position: (sonKart?.position ?? 0) + 1,
          lastActivityAt: new Date(),
        },
      });

      // Manuel tasima ile ayni event: bunu yayinlamazsak diger acik
      // panolar (ve karti tasiyan otomasyonu tetikleyen kullanicinin
      // KENDI panosu) kart yeni sutuna gecene kadar hicbir sey gormez.
      broadcastToProject(rule.projectId, SocketEvents.CARD_MOVED, {
        cardId: updated.id,
        fromColumnId: before.columnId,
        toColumnId: updated.columnId,
        position: updated.position,
        projectId: rule.projectId,
      });

      // Manuel tasimanin (card.service.ts:443-465) uc yan etkisi otomasyon
      // yolunda da calismali; yoksa kartin Done'a nasil geldigine dair denetim
      // izi kopuyor, karti izleyenlere hicbir bildirim gitmiyor ve hedef sutun
      // isDone olsa bile bu karti bekleyen bagimli kartlarin sahipleri
      // blokajin kalktigini ogrenemiyor. Aksiyonu tetikleyen "kullanici"
      // otomasyonda kurali kuran kisi kabul ediliyor.
      await logActivity({
        projectId: rule.projectId,
        userId: rule.createdById,
        type: "CARD_MOVED",
        cardId: updated.id,
        data: { from: before.column.name, to: column.name },
      });

      await notifyWatchers(
        updated.id,
        rule.createdById,
        `"${updated.title}" kartı "${before.column.name}" sütunundan "${column.name}" sütununa taşındı`,
      );

      if (column.isDone) {
        await notifyBlockerResolved(updated.id, updated.title);
        await logActivity({
          projectId: rule.projectId,
          userId: rule.createdById,
          type: "CARD_COMPLETED",
          cardId: updated.id,
        });
      }
      return;
    }
    case "ASSIGN_USER": {
      if (!rule.actionUserId) return;

      // Calisma aninda tekrar dogruluyoruz: kisi kural kurulduktan sonra
      // organizasyondan cikarilmis olabilir. Org disi birine kart atamak
      // sadece DB tutarsizligi degil - gunluk ozet e-postasi ve bildirim
      // kart basligini o kisiye tasiyor (manuel yol validateAssignees ile
      // ayni sarti koyuyor).
      const proje = await prisma.project.findUnique({
        where: { id: rule.projectId },
        select: { organizationId: true },
      });
      if (!proje) return;
      const uye = await prisma.organizationMember.findFirst({
        where: { organizationId: proje.organizationId, userId: rule.actionUserId },
        select: { userId: true },
      });
      if (!uye) {
        console.warn(`[automation] "${rule.name}": atanacak kisi artik organizasyon uyesi degil, atlandi`);
        return;
      }

      // Tekrar korumasi: upsert atama zaten varken de sessizce gecip her
      // seferinde YENI bir bildirim ve socket yayini uretiyordu. CARD_DUE_SOON
      // tetikleyicisi ayni karti her gece (ustelik in-process cron + GitHub
      // Actions olmak uzere iki kez) yeniden isledigi icin ayni atama bildirimi
      // gunlerce birikiyordu - SEND_NOTIFICATION dalindaki ayni gerekceli
      // kontrolun karsiligi. createMany + skipDuplicates hem tek sorguda
      // atomik hem de count ile atamanin GERCEKTEN yeni olup olmadigini soyler.
      const eklendi = await prisma.cardAssignee.createMany({
        data: [{ cardId, userId: rule.actionUserId }],
        skipDuplicates: true,
      });
      if (eklendi.count === 0) return;

      const card = await prisma.card.findUnique({
        where: { id: cardId },
        select: {
          title: true,
          description: true,
          columnId: true,
          priority: true,
          dueDate: true,
          startDate: true,
          position: true,
          assignees: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } },
        },
      });
      if (!card) return;

      // Manuel atamayla ayni event (CARD_ASSIGNED yerine CARD_UPDATED - frontend'in
      // zaten dinledigi onCardUpdated handler'i assignees'i ayni sekilde birlestiriyor).
      // Bu olmadan otomasyonun atadigi kisi DB'de dogru ama acik panoda sayfa
      // yenilenene kadar hic gorunmuyordu.
      broadcastToProject(rule.projectId, SocketEvents.CARD_UPDATED, {
        id: cardId,
        title: card.title,
        description: card.description,
        columnId: card.columnId,
        projectId: rule.projectId,
        assignees: card.assignees.map((a) => ({ id: a.user.id, name: a.user.name, avatarUrl: a.user.avatarUrl })),
        priority: card.priority,
        dueDate: card.dueDate?.toISOString() ?? null,
        startDate: card.startDate?.toISOString() ?? null,
        position: card.position,
      });

      await notificationService.createNotification({
        userId: rule.actionUserId,
        type: "AUTOMATION",
        message: `"${rule.name}" kuralı seni "${card.title}" kartına atadı`,
        cardId,
      });
      return;
    }
    case "SEND_NOTIFICATION": {
      if (!rule.actionUserId || !rule.actionMessage) return;
      // Ayni karta ayni mesajla okunmamis bir bildirim zaten varsa tekrar
      // olusturma - CARD_DUE_SOON tetikleyicisi gece taramasinda her calistiginda
      // ayni karti tekrar tekrar isaretleyebiliyor, bu spam'i onler.
      const existing = await prisma.notification.findFirst({
        where: { userId: rule.actionUserId, type: "AUTOMATION", message: rule.actionMessage, cardId, read: false },
      });
      if (existing) return;
      await notificationService.createNotification({
        userId: rule.actionUserId,
        type: "AUTOMATION",
        message: rule.actionMessage,
        cardId,
      });
      return;
    }
  }
}

// SCHEDULED tetikleyicisi kartlara degil dogrudan kurala bagli oldugu icin
// (henuz var olmayan bir kart olusturuyor) executeAction'in cardId gerektiren
// imzasini kullanamaz - ayri bir yol izler.
async function executeCreateCardAction(rule: AutomationRule) {
  if (rule.actionType !== "CREATE_CARD") return;
  if (!rule.actionColumnId) return;

  const column = await prisma.column.findUnique({ where: { id: rule.actionColumnId } });
  if (!column) return; // kolon silinmis - sessizce atla
  // Kart numarasi allocateCardNumber(rule.projectId) ile KURALIN projesinden
  // aliniyor; kolon baska bir projeye aitse o projede cakisan bir kart
  // anahtari (ayni QNT-42) uretilir ve findCardByKey yanlis karti dondurur.
  if (column.projectId !== rule.projectId) return;

  const lastCard = await prisma.card.findFirst({
    where: { columnId: rule.actionColumnId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const position = (lastCard?.position ?? 0) + 1;

  // Otomasyonun açtığı kart da anahtar alır: "kural açtı" olması onu
  // referans verilemez bir kart yapmamalı.
  const number = await allocateCardNumber(rule.projectId);

  const card = await prisma.card.create({
    data: {
      columnId: rule.actionColumnId,
      number,
      title: rule.actionMessage ?? rule.name,
      creatorId: rule.createdById,
      position,
      lastActivityAt: new Date(),
    },
  });

  broadcastToProject(rule.projectId, SocketEvents.CARD_CREATED, {
    id: card.id,
    title: card.title,
    description: card.description ?? undefined,
    columnId: card.columnId,
    projectId: rule.projectId,
    assignees: [],
    priority: card.priority,
    dueDate: undefined,
    position: card.position,
  });

  await logActivity({ projectId: rule.projectId, userId: rule.createdById, type: "CARD_CREATED", cardId: card.id });
}

// Gece taramasinda (scan.service.ts -> runNightlyScan) cagrilir. Iki bagimsiz
// tetikleyici turunu isler: SCHEDULED (gunun gunune gore, kart-bagimsiz aksiyon)
// ve CARD_DUE_SOON (teslim tarihi yaklasan, henuz Done olmayan her kart icin
// normal executeAction akisini calistirir).
export async function runScheduledAndDueSoonAutomations() {
  const dayOfWeek = new Date().getDay();

  const scheduledRules = await prisma.automationRule.findMany({
    where: {
      trigger: "SCHEDULED",
      isActive: true,
      OR: [{ scheduleDayOfWeek: dayOfWeek }, { scheduleDayOfWeek: null }],
    },
  });
  for (const rule of scheduledRules) {
    try {
      await executeCreateCardAction(rule);
    } catch (error) {
      console.error(`[automation] scheduled "${rule.name}" kurali calisirken hata:`, error);
    }
  }

  const dueSoonRules = await prisma.automationRule.findMany({
    where: { trigger: "CARD_DUE_SOON", isActive: true, dueSoonDays: { not: null } },
  });
  for (const rule of dueSoonRules) {
    if (rule.dueSoonDays == null) continue;
    const now = new Date();
    const threshold = new Date(now.getTime() + rule.dueSoonDays * 24 * 60 * 60 * 1000);
    const dueSoonCards = await prisma.card.findMany({
      where: {
        column: { projectId: rule.projectId, isDone: false },
        dueDate: { gte: now, lte: threshold },
        isArchived: false,
      },
      select: { id: true },
    });
    for (const card of dueSoonCards) {
      try {
        if (!(await cardMatchesConditions(rule, card.id))) continue;
        await executeAction(rule, card.id);
      } catch (error) {
        console.error(`[automation] due-soon "${rule.name}" kurali calisirken hata:`, error);
      }
    }
  }

  return { scheduledRulesRun: scheduledRules.length, dueSoonRulesChecked: dueSoonRules.length };
}
