import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import * as notificationService from "@/services/notification.service";
import type { AutomationRule, AutomationTrigger } from "@prisma/client";
import type { CreateAutomationRuleInput, UpdateAutomationRuleInput } from "@/schemas/automation.schema";

async function checkProjectAdmin(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  if (!project) throw new NotFoundError("Proje");

  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: project.organizationId, userId } },
  });
  if (!member) throw new ForbiddenError("Bu projeye erişim yetkiniz yok");
  if (member.role !== "ADMIN") throw new ForbiddenError("Otomasyon kurallarını sadece adminler yönetebilir");
}

export async function listAutomationRules(projectId: string, userId: string) {
  await checkProjectAdmin(projectId, userId);
  return prisma.automationRule.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}

export async function createAutomationRule(projectId: string, input: CreateAutomationRuleInput, userId: string) {
  await checkProjectAdmin(projectId, userId);

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
      createdById: userId,
    },
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
      await prisma.card.update({
        where: { id: cardId },
        data: { columnId: rule.actionColumnId, lastActivityAt: new Date() },
      });
      return;
    }
    case "ASSIGN_USER": {
      if (!rule.actionUserId) return;
      await prisma.cardAssignee.upsert({
        where: { cardId_userId: { cardId, userId: rule.actionUserId } },
        create: { cardId, userId: rule.actionUserId },
        update: {},
      });
      const card = await prisma.card.findUnique({ where: { id: cardId }, select: { title: true } });
      await notificationService.createNotification({
        userId: rule.actionUserId,
        type: "AUTOMATION",
        message: `"${rule.name}" kuralı seni "${card?.title}" kartına atadı`,
        cardId,
      });
      return;
    }
    case "SEND_NOTIFICATION": {
      if (!rule.actionUserId || !rule.actionMessage) return;
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
