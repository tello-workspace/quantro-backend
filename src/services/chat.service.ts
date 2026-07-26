import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import { broadcastToOrganization, SocketEvents } from "@/server/socket";
import type { CreateChatMessageInput, ListChatMessagesInput } from "@/schemas/chat.schema";

// Organizasyon sohbeti sadece o organizasyonun uyelerine acik
async function checkOrganizationAccess(organizationId: string, userId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true },
  });
  if (!organization) throw new NotFoundError("Organizasyon");

  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!member) throw new ForbiddenError("Bu sohbete erişim yetkiniz yok");

  return { role: member.role };
}

// Mesajlar en yeniden eskiye cekilir (sayfalama icin), donerken
// ekranda dogru sirada olsun diye eskiden yeniye cevrilir.
export async function getMessages(
  organizationId: string,
  input: ListChatMessagesInput,
  userId: string,
) {
  await checkOrganizationAccess(organizationId, userId);

  let cursorFilter = {};
  if (input.before) {
    const cursorMessage = await prisma.chatMessage.findUnique({
      where: { id: input.before },
      select: { createdAt: true },
    });
    if (cursorMessage) {
      cursorFilter = { createdAt: { lt: cursorMessage.createdAt } };
    }
  }

  const messages = await prisma.chatMessage.findMany({
    where: { organizationId, ...cursorFilter },
    orderBy: { createdAt: "desc" },
    take: input.limit,
    include: {
      author: { select: { id: true, name: true, email: true } },
    },
  });

  return messages.reverse();
}

export async function createMessage(
  organizationId: string,
  input: CreateChatMessageInput,
  userId: string,
) {
  await checkOrganizationAccess(organizationId, userId);

  const message = await prisma.chatMessage.create({
    data: {
      organizationId,
      authorId: userId,
      text: input.text,
    },
    include: {
      author: { select: { id: true, name: true, email: true } },
    },
  });

  broadcastToOrganization(organizationId, SocketEvents.CHAT_MESSAGE_NEW, {
    id: message.id,
    organizationId,
    authorId: message.authorId,
    authorName: message.author.name,
    text: message.text,
    createdAt: message.createdAt.toISOString(),
  });

  return message;
}
