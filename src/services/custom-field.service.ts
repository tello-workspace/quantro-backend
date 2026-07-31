import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ConflictError } from "@/utils/errors";
import { broadcastToProject, SocketEvents } from "@/server/socket";
import type { CreateCustomFieldInput, UpdateCustomFieldValueInput } from "@/schemas/custom-field.schema";

async function checkProjectAccess(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  if (!project) throw new NotFoundError("Proje");

  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: project.organizationId, userId } },
  });
  if (!member) throw new ForbiddenError("Bu projeye erişim yetkiniz yok");

  return { role: member.role };
}

export async function listCustomFields(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);
  return prisma.customFieldDefinition.findMany({
    where: { projectId },
    orderBy: { position: "asc" },
  });
}

export async function createCustomField(projectId: string, input: CreateCustomFieldInput, userId: string) {
  const { role } = await checkProjectAccess(projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Ek alanları sadece adminler yönetebilir");

  const existing = await prisma.customFieldDefinition.findUnique({
    where: { projectId_name: { projectId, name: input.name } },
  });
  if (existing) throw new ConflictError("Bu isimde bir alan zaten var");

  const lastField = await prisma.customFieldDefinition.findFirst({
    where: { projectId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const field = await prisma.customFieldDefinition.create({
    data: {
      projectId,
      name: input.name,
      type: input.type,
      options: input.type === "SELECT" ? (input.options ?? []) : [],
      position: (lastField?.position ?? 0) + 1,
    },
  });

  broadcastToProject(projectId, SocketEvents.CUSTOM_FIELD_CHANGED, { projectId });

  return field;
}

export async function deleteCustomField(fieldId: string, userId: string) {
  const field = await prisma.customFieldDefinition.findUnique({ where: { id: fieldId } });
  if (!field) throw new NotFoundError("Ek alan");

  const { role } = await checkProjectAccess(field.projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Ek alanları sadece adminler yönetebilir");

  await prisma.customFieldDefinition.delete({ where: { id: fieldId } });

  broadcastToProject(field.projectId, SocketEvents.CUSTOM_FIELD_CHANGED, { projectId: field.projectId });
}

// Uyeler de kendi kartlarindaki ek alan degerlerini doldurabilir - bu
// AutomationRule/CustomFieldDefinition yaratma gibi yapisal bir degisiklik
// degil, storyPoints/priority gibi bir "icerik" alani niteliginde ama
// ChangeRequest akisina sokmuyoruz cunku veri kaybi riski yok (upsert).
export async function setCardCustomFieldValue(
  cardId: string,
  fieldId: string,
  input: UpdateCustomFieldValueInput,
  userId: string,
) {
  const field = await prisma.customFieldDefinition.findUnique({ where: { id: fieldId } });
  if (!field) throw new NotFoundError("Ek alan");

  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { column: { select: { projectId: true } } },
  });
  if (!card) throw new NotFoundError("Kart");
  if (card.column.projectId !== field.projectId) {
    throw new ForbiddenError("Bu ek alan bu karta ait değil");
  }

  await checkProjectAccess(field.projectId, userId);

  const value = await prisma.cardCustomFieldValue.upsert({
    where: { cardId_fieldId: { cardId, fieldId } },
    create: { cardId, fieldId, value: input.value },
    update: { value: input.value },
  });

  broadcastToProject(field.projectId, SocketEvents.CUSTOM_FIELD_CHANGED, { projectId: field.projectId, cardId });

  return value;
}
