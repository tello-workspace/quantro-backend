import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ValidationError } from "@/utils/errors";
import { logActivity } from "@/services/activity.service";
import { checkCardAccess } from "@/services/access-control.service";
import { broadcastToProject, SocketEvents } from "@/server/socket";
import * as notificationService from "@/services/notification.service";
import { notifyWatchers, autoWatch } from "@/services/watcher.service";
import { dispatchEvent } from "@/services/webhook.service";
import type { CreateCommentInput, UpdateCommentInput } from "@/schemas/comment.schema";

const authorSelect = { select: { id: true, name: true, email: true, avatarUrl: true } } as const;
const reactionSelect = { select: { userId: true, emoji: true } } as const;

// Yorum metninde "@Ad Soyad" gecen organizasyon uyelerini bulur. Ozel bir
// mention-token formati yok (frontend'deki otomatik tamamlama tam adi
// yaziyor) - bu yuzden en guvenilir yol, bilinen uye adlarini metinde
// dogrudan aramak. Regex ile isim ayristirmaya calismak (bosluklu isimler
// yuzunden) yanlis pozitif/negatif uretebilirdi.
async function extractMentionedUserIds(
  text: string,
  organizationId: string,
  excludeUserId: string,
): Promise<string[]> {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId },
    select: { userId: true, user: { select: { name: true } } },
  });

  const lowerText = text.toLowerCase();
  const mentioned = new Set<string>();
  for (const m of members) {
    if (m.userId === excludeUserId) continue;
    if (lowerText.includes(`@${m.user.name}`.toLowerCase())) {
      mentioned.add(m.userId);
    }
  }
  return Array.from(mentioned);
}

// Kok yorumlari, her birinin yanitlariyla birlikte dondurur. Tek seviye
// thread oldugu icin (bkz. schema yorumu) replies kendi ici tekrar
// dallanmiyor - duz bir liste yeterli.
export async function getComments(cardId: string, userId: string) {
  await checkCardAccess(cardId, userId);

  const comments = await prisma.comment.findMany({
    where: { cardId, parentCommentId: null },
    orderBy: { createdAt: "asc" },
    include: {
      author: authorSelect,
      resolvedBy: { select: { id: true, name: true } },
      reactions: reactionSelect,
      replies: {
        orderBy: { createdAt: "asc" },
        include: { author: authorSelect, reactions: reactionSelect },
      },
    },
  });

  return comments;
}

export async function createComment(cardId: string, input: CreateCommentInput, userId: string) {
  const { projectId, organizationId, cardTitle } = await checkCardAccess(cardId, userId);

  // Sinirsiz ic ice yorumu onlemek icin: hedef parent'in KENDI parent'i varsa
  // (yani o da bir yanitsa) gercek hedef onun kok yorumu olur. Kullanici
  // "yanita yanit ver" diye ugrasmaz, sessizce dogru yere baglanir.
  let parentCommentId: string | null = null;
  if (input.parentCommentId) {
    const parent = await prisma.comment.findUnique({
      where: { id: input.parentCommentId },
      select: { id: true, cardId: true, parentCommentId: true, authorId: true },
    });
    if (!parent || parent.cardId !== cardId) throw new NotFoundError("Yanıtlanan yorum");
    parentCommentId = parent.parentCommentId ?? parent.id;
  }

  const comment = await prisma.comment.create({
    data: {
      cardId,
      authorId: userId,
      text: input.text,
      parentCommentId,
    },
    include: { author: authorSelect },
  });

  broadcastToProject(projectId, SocketEvents.COMMENT_ADDED, {
    id: comment.id,
    cardId,
    authorId: comment.authorId,
    authorName: comment.author.name,
    text: comment.text,
    createdAt: comment.createdAt.toISOString(),
    parentCommentId: comment.parentCommentId,
  });

  await logActivity({
    projectId,
    userId,
    type: "COMMENT_ADDED",
    cardId,
    data: { preview: comment.text.slice(0, 80) },
  });

  void dispatchEvent(projectId, "CARD_COMMENTED", {
    cardId,
    title: cardTitle,
    authorName: comment.author.name,
    text: comment.text,
  });

  const mentionedUserIds = await extractMentionedUserIds(input.text, organizationId, userId);
  for (const mentionedUserId of mentionedUserIds) {
    await notificationService.createNotification({
      userId: mentionedUserId,
      type: "MENTIONED",
      message: `${comment.author.name} seni bir yorumda etiketledi: "${comment.text.slice(0, 80)}"`,
      cardId,
    });
  }

  await notifyWatchers(cardId, userId, `${comment.author.name} izlediğin "${cardTitle}" kartına yorum yaptı`);

  // Yorum yazan kişi otomatik izleyici olur (Jira davranışı): bir karta yorum
  // yazdıysan cevabını görmek istersin. Kendi yorumundan bildirim almaz -
  // notifyWatchers yazarı zaten dışlıyor.
  await autoWatch(cardId, userId);

  return comment;
}

export async function getCommentById(commentId: string, userId: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: {
      author: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
  });
  if (!comment) throw new NotFoundError("Yorum");

  // Yorumun ait olduğu karta erişim yetkisini kontrol et
  await checkCardAccess(comment.cardId, userId);

  return comment;
}

export async function updateComment(commentId: string, input: UpdateCommentInput, userId: string) {
  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment) throw new NotFoundError("Yorum");

  // Sadece yazarı düzenleyebilir
  if (comment.authorId !== userId) throw new ForbiddenError("Sadece kendi yorumunuzu düzenleyebilirsiniz");

  // Kart erişim kontrolü
  const { projectId } = await checkCardAccess(comment.cardId, userId);

  const updated = await prisma.comment.update({
    where: { id: commentId },
    data: { text: input.text, editedAt: new Date() },
    include: { author: authorSelect },
  });

  broadcastToProject(projectId, SocketEvents.COMMENT_UPDATED, {
    id: updated.id,
    cardId: updated.cardId,
    authorId: updated.authorId,
    authorName: updated.author.name,
    text: updated.text,
    createdAt: updated.createdAt.toISOString(),
    editedAt: updated.editedAt?.toISOString() ?? null,
  });

  return updated;
}

// Cozuldu/ac islemi sadece KOK yoruma (thread) uygulanir - GitHub PR'daki
// "resolve conversation" gibi yazardan bagimsiz bir takim eylemi, bu yuzden
// yazar kontrolu yok, sadece karta erisim yeterli.
export async function resolveComment(commentId: string, userId: string, resolved: boolean) {
  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment) throw new NotFoundError("Yorum");
  if (comment.parentCommentId) throw new ValidationError("Bir yanıt tek başına çözüldü işaretlenemez");

  const { projectId } = await checkCardAccess(comment.cardId, userId);

  const updated = await prisma.comment.update({
    where: { id: commentId },
    data: resolved
      ? { resolvedAt: new Date(), resolvedById: userId }
      : { resolvedAt: null, resolvedById: null },
    include: { resolvedBy: { select: { id: true, name: true } } },
  });

  broadcastToProject(projectId, SocketEvents.COMMENT_UPDATED, {
    id: updated.id,
    cardId: updated.cardId,
    resolvedAt: updated.resolvedAt?.toISOString() ?? null,
    resolvedBy: updated.resolvedBy,
  });

  return updated;
}

// Toggle: ayni kullanici ayni emoji ile tekrar tiklarsa reaksiyon kalkar.
export async function toggleReaction(commentId: string, userId: string, emoji: string) {
  const comment = await prisma.comment.findUnique({ where: { id: commentId }, select: { cardId: true } });
  if (!comment) throw new NotFoundError("Yorum");

  const { projectId } = await checkCardAccess(comment.cardId, userId);

  const existing = await prisma.commentReaction.findUnique({
    where: { commentId_userId_emoji: { commentId, userId, emoji } },
  });

  if (existing) {
    await prisma.commentReaction.delete({
      where: { commentId_userId_emoji: { commentId, userId, emoji } },
    });
  } else {
    await prisma.commentReaction.create({ data: { commentId, userId, emoji } });
  }

  const reactions = await prisma.commentReaction.findMany({
    where: { commentId },
    select: { userId: true, emoji: true },
  });

  broadcastToProject(projectId, SocketEvents.COMMENT_UPDATED, {
    id: commentId,
    cardId: comment.cardId,
    reactions,
  });

  return reactions;
}

export async function deleteComment(commentId: string, userId: string) {
  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment) throw new NotFoundError("Yorum");

  // Sadece yazarı silebilir
  if (comment.authorId !== userId) throw new ForbiddenError("Sadece kendi yorumunuzu silebilirsiniz");

  // Kart erişim kontrolü
  const { projectId } = await checkCardAccess(comment.cardId, userId);

  await prisma.comment.delete({ where: { id: commentId } });

  broadcastToProject(projectId, SocketEvents.COMMENT_DELETED, {
    commentId,
    cardId: comment.cardId,
  });
}
