import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ValidationError } from "@/utils/errors";
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
    // Imlec org'a kapsanmali: findUnique ile aranirsa baska bir organizasyonun
    // mesaj id'si de kabul edilir ve onun createdAt'i bizim sorgumuza filtre olur.
    const cursorMessage = await prisma.chatMessage.findFirst({
      where: { id: input.before, organizationId },
      select: { id: true, createdAt: true },
    });
    // Imlec bulunamazsa (silinmis mesaj, hatali id) eskiden cursorFilter bos
    // kalip sorgu EN YENI mesajlari donduruyordu; istemci bunlari listenin
    // ustune ekleyince ayni mesajlar tekrarlaniyor ve sonsuz kaydirma bitmiyordu.
    // Sessizce yok saymak yerine acikca hata veriyoruz.
    if (!cursorMessage) throw new ValidationError("Geçersiz sayfalama imleci");
    // Ayni milisaniyeye denk gelen mesajlarin atlanmamasi/tekrarlanmamasi icin
    // imlec (createdAt, id) ikili anahtari uzerinden karsilastiriliyor.
    cursorFilter = {
      OR: [
        { createdAt: { lt: cursorMessage.createdAt } },
        { createdAt: cursorMessage.createdAt, id: { lt: cursorMessage.id } },
      ],
    };
  }

  const messagesQuery = prisma.chatMessage.findMany({
    where: { organizationId, ...cursorFilter },
    // Ikili anahtarli imlecle tutarli olmasi icin siralama da (createdAt, id).
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
