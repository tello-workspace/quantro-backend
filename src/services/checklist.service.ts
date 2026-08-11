import { prisma } from "@/lib/prisma";
import { NotFoundError } from "@/utils/errors";
import { checkCardAccess } from "@/services/access-control.service";
import { broadcastToProject, SocketEvents } from "@/server/socket";
import type { CreateChecklistItemInput, UpdateChecklistItemInput } from "@/schemas/checklist.schema";

export async function getChecklistItems(cardId: string, userId: string) {
  await checkCardAccess(cardId, userId);

  return prisma.checklistItem.findMany({
    where: { cardId },
    orderBy: { position: "asc" },
  });
}

export async function createChecklistItem(cardId: string, input: CreateChecklistItemInput, userId: string) {
  const { projectId } = await checkCardAccess(cardId, userId);

  // Siraya sona ekle: mevcut en yuksek position + 1 (Card.position ile ayni fractional-indexing mantigi)
  const last = await prisma.checklistItem.findFirst({
    where: { cardId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const item = await prisma.checklistItem.create({
    data: {
      cardId,
      text: input.text,
      position: (last?.position ?? 0) + 1,
    },
  });

  broadcastToProject(projectId, SocketEvents.CHECKLIST_ITEM_ADDED, {
    id: item.id,
    cardId: item.cardId,
    text: item.text,
    done: item.done,
    position: item.position,
  });

  return item;
}

export async function updateChecklistItem(itemId: string, input: UpdateChecklistItemInput, userId: string) {
  const existing = await prisma.checklistItem.findUnique({ where: { id: itemId } });
  if (!existing) throw new NotFoundError("Checklist maddesi");

  const { projectId } = await checkCardAccess(existing.cardId, userId);

  const item = await prisma.checklistItem.update({
    where: { id: itemId },
    data: {
      ...(input.text !== undefined && { text: input.text }),
      ...(input.done !== undefined && { done: input.done }),
      ...(input.position !== undefined && { position: input.position }),
    },
  });

  broadcastToProject(projectId, SocketEvents.CHECKLIST_ITEM_UPDATED, {
    id: item.id,
    cardId: item.cardId,
    text: item.text,
    done: item.done,
    position: item.position,
  });

  return item;
}

export async function deleteChecklistItem(itemId: string, userId: string) {
  const existing = await prisma.checklistItem.findUnique({ where: { id: itemId } });
  if (!existing) throw new NotFoundError("Checklist maddesi");

  const { projectId } = await checkCardAccess(existing.cardId, userId);

  await prisma.checklistItem.delete({ where: { id: itemId } });

  broadcastToProject(projectId, SocketEvents.CHECKLIST_ITEM_DELETED, {
    cardId: existing.cardId,
    itemId,
  });
}
