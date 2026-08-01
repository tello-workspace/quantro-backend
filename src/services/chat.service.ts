import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import { broadcastToOrganization, SocketEvents } from "@/server/socket";
import type { CreateChatMessageInput, ListChatMessagesInput } from "@/schemas/chat.schema";

// Organizasyon sohbeti sadece o organizasyonun uyelerine acik.
// Basarili durumda tek sorgu; "organizasyon yok mu, uye degil mi" ayrimi
// icin ikinci sorgu yalnizca hata yolunda atiliyor.
async function checkOrganizationAccess(organizationId: string, userId: string) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true },
  });
  if (member) return { role: member.role };

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true },
  });
  if (!organization) throw new NotFoundError("Organizasyon");
  throw new ForbiddenError("Bu sohbete erişim yetkiniz yok");
}

// Mesajlar en yeniden eskiye cekilir (sayfalama icin), donerken
// ekranda dogru sirada olsun diye eskiden yeniye cevrilir.
export async function getMessages(
  organizationId: string,
  input: ListChatMessagesInput,
  userId: string,
) {
  // Imlec yoksa (ilk acilis) erisim kontrolu ile mesaj sorgusu paralel gider.
  // Imlec varsa once o mesajin tarihini bilmemiz gerektigi icin sirali kalir.
  let cursorFilter = {};
  if (input.before) {
    await checkOrganizationAccess(organizationId, userId);
    const cursorMessage = await prisma.chatMessage.findUnique({
      where: { id: input.before },
      select: { createdAt: true },
    });
    if (cursorMessage) {
      cursorFilter = { createdAt: { lt: cursorMessage.createdAt } };
    }
  }

  const messagesQuery = prisma.chatMessage.findMany({
    where: { organizationId, ...cursorFilter },
    orderBy: { createdAt: "desc" },
    take: input.limit,
    include: {
      author: { select: { id: true, name: true, email: true } },
    },
  });

  const [, messages] = input.before
    ? [null, await messagesQuery]
    : await Promise.all([checkOrganizationAccess(organizationId, userId), messagesQuery]);

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
