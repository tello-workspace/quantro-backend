import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ValidationError, AppError } from "@/utils/errors";
import { supabaseAdmin, ATTACHMENTS_BUCKET, storageKeyHint } from "@/lib/supabaseAdmin";
import { broadcastToUser, SocketEvents } from "@/server/socket";
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE } from "@/lib/attachment-policy";
import type { ComposeMailInput, RecipientGroup, ReplyMailInput } from "@/schemas/mail.schema";

const SIGNED_URL_TTL_SECONDS = 60 * 60;
const MAX_ATTACHMENTS_PER_MAIL = 10;

async function requireMembership(organizationId: string, userId: string) {
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!membership) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");
  return membership;
}

// Grup secimleri ("Tum organizasyon", "Sadece Adminler", "Proje X Ekibi")
// GONDERIM ANINDA somut kullanici id'lerine cozulur - dosya basindaki nota
// bakin (dinamik referans degil, anlik goruntu). Istemciden gelen tekil
// recipientUserIds de burada organizasyon uyeligine karsi DOGRULANIR.
async function resolveRecipients(
  organizationId: string,
  recipientUserIds: string[],
  recipientGroups: RecipientGroup[],
  excludeUserId: string,
): Promise<string[]> {
  const idSet = new Set<string>(recipientUserIds);

  for (const grup of recipientGroups) {
    if (grup.type === "ORGANIZATION") {
      const uyeler = await prisma.organizationMember.findMany({
        where: { organizationId },
        select: { userId: true },
      });
      uyeler.forEach((u) => idSet.add(u.userId));
    } else if (grup.type === "ADMINS") {
      const uyeler = await prisma.organizationMember.findMany({
        where: { organizationId, role: "ADMIN" },
        select: { userId: true },
      });
      uyeler.forEach((u) => idSet.add(u.userId));
    } else {
      const proje = await prisma.project.findFirst({
        where: { id: grup.projectId, organizationId },
        select: { ownerId: true },
      });
      if (!proje) continue; // baska organizasyonun projesi sizarsa sessizce atla
      const uyeler = await prisma.projectMember.findMany({
        where: { projectId: grup.projectId },
        select: { userId: true },
      });
      uyeler.forEach((u) => idSet.add(u.userId));
      idSet.add(proje.ownerId);
    }
  }

  idSet.delete(excludeUserId);
  if (idSet.size === 0) return [];

  const gecerliUyeler = await prisma.organizationMember.findMany({
    where: { organizationId, userId: { in: Array.from(idSet) } },
    select: { userId: true },
  });
  return gecerliUyeler.map((u) => u.userId);
}

async function notifyRecipients(mail: { id: string; subject: string; senderName: string }, recipientIds: string[]) {
  if (recipientIds.length === 0) return;

  await prisma.notification.createMany({
    data: recipientIds.map((userId) => ({
      userId,
      type: "MAIL_RECEIVED" as const,
      message: `${mail.senderName}: "${mail.subject}"`,
    })),
  });

  const createdAt = new Date().toISOString();
  for (const userId of recipientIds) {
    // NOTIFICATION_NEW: mevcut zil/toast altyapisi baska bir degisiklik
    // gerekmeden bunu da gosterir. MAIL_NEW ise ayrica - acik Mail
    // sayfasinin listeyi anlik tazelemesi icin ozel bir sinyal.
    broadcastToUser(userId, SocketEvents.NOTIFICATION_NEW, {
      userId,
      type: "MAIL_RECEIVED",
      message: `${mail.senderName}: "${mail.subject}"`,
      read: false,
      createdAt,
    });
    broadcastToUser(userId, SocketEvents.MAIL_NEW, {
      mailId: mail.id,
      subject: mail.subject,
      senderName: mail.senderName,
    });
  }
}

const mailListSelect = {
  id: true,
  subject: true,
  body: true,
  isDraft: true,
  createdAt: true,
  sentAt: true,
  parentMailId: true,
  threadId: true,
  sender: { select: { id: true, name: true } },
  _count: { select: { attachments: true } },
} as const;

// "Yn:" / "İlt:" onekleri. Zaten onekli bir konuya tekrar eklenmez -
// e-posta istemcilerindeki "Re: Re: Re:" birikmesini onlemek icin. Karsi
// modun oneki varsa (yaniti iletirken) o temizlenip yenisi konur.
const REPLY_PREFIX = "Yn:";
const FORWARD_PREFIX = "İlt:";

function prefixSubject(subject: string, prefix: string): string {
  const sade = subject.replace(/^\s*(Yn:|İlt:)\s*/i, "").trim();
  const konu = `${prefix} ${sade}`;
  // Konu sutunu 200 karakterle sinirli (composeMailSchema ile ayni sinir).
  return konu.length > 200 ? `${konu.slice(0, 199)}…` : konu;
}

// Yanitlanan mesaji ">" ile alintilar - duz metin govdede standart davranis.
function quoteBody(original: { senderName: string; sentAt: Date | null; body: string }): string {
  const tarih = original.sentAt ? original.sentAt.toLocaleString("tr-TR") : "";
  const baslik = tarih
    ? `${tarih} tarihinde ${original.senderName} yazdı:`
    : `${original.senderName} yazdı:`;
  const alinti = original.body
    .split("\n")
    .map((satir) => `> ${satir}`)
    .join("\n");
  return `\n\n${baslik}\n${alinti}`;
}

// Bir mesaja SADECE gonderen veya alicilarindan biri erisebilir - getMail'deki
// kuralin ayni. Yanitlama/iletme de bu kapidan geciyor ki, mesaji gormeye
// yetkisi olmayan biri parentMailId gondererek baskasinin konusmasina
// yamanamasin (ve alintilanan govdeyi ogrenemesin).
async function loadMailForReply(mailId: string, userId: string) {
  const mail = await prisma.mail.findUnique({
    where: { id: mailId },
    include: {
      sender: { select: { id: true, name: true } },
      recipients: { select: { userId: true } },
    },
  });
  if (!mail) throw new NotFoundError("Mesaj");

  const aliciMi = mail.recipients.some((r) => r.userId === userId);
  if (mail.senderId !== userId && !aliciMi) {
    throw new ForbiddenError("Bu mesaja erişim yetkiniz yok");
  }
  // Gonderilmemis bir taslak yanitlanamaz - henuz kimseye ulasmadi.
  if (mail.isDraft) throw new ValidationError("Taslak bir mesaj yanıtlanamaz");

  return mail;
}

// parentMailId'den { parentMailId, threadId } turetir. Zincir TEK SEVIYE
// tutuluyor: bir yanita yanit verildiginde threadId degismiyor, yalnizca
// parentMailId dogrudan cevaplanani gosteriyor.
async function resolveThreadLink(
  parentMailId: string | undefined,
  organizationId: string,
  userId: string,
): Promise<{ parentMailId: string | null; threadId: string | null }> {
  if (!parentMailId) return { parentMailId: null, threadId: null };

  const kaynak = await loadMailForReply(parentMailId, userId);
  if (kaynak.organizationId !== organizationId) {
    throw new ForbiddenError("Bu mesaja erişim yetkiniz yok");
  }
  return { parentMailId: kaynak.id, threadId: kaynak.threadId ?? kaynak.id };
}

export async function composeMail(
  organizationId: string,
  input: Partial<ComposeMailInput> & Pick<ComposeMailInput, "subject" | "body">,
  userId: string,
) {
  await requireMembership(organizationId, userId);

  const isDraft = input.isDraft ?? false;
  const recipientIds = await resolveRecipients(
    organizationId,
    input.recipientUserIds ?? [],
    input.recipientGroups ?? [],
    userId,
  );
  if (!isDraft && recipientIds.length === 0) {
    throw new ValidationError("En az bir alıcı seçilmeli");
  }

  // Yanit zinciri: parentMailId verildiyse kaynagin erisim kontrolunden
  // gecilir ve konusma koku devralinir.
  const zincir = await resolveThreadLink(input.parentMailId, organizationId, userId);

  const mail = await prisma.mail.create({
    data: {
      organizationId,
      senderId: userId,
      subject: input.subject,
      body: input.body,
      isDraft,
      sentAt: isDraft ? null : new Date(),
      parentMailId: zincir.parentMailId,
      threadId: zincir.threadId,
      recipients:
        recipientIds.length > 0 ? { createMany: { data: recipientIds.map((id) => ({ userId: id })) } } : undefined,
    },
    select: mailListSelect,
  });

  // Kok mesajlarda threadId = kendi id'si; boylece "konusmayi getir" her
  // zaman tek bir esitlik sorgusu ( threadId = X ) olur.
  if (!zincir.threadId) {
    await prisma.mail.update({ where: { id: mail.id }, data: { threadId: mail.id } });
    mail.threadId = mail.id;
  }

  if (!isDraft) {
    await notifyRecipients({ id: mail.id, subject: mail.subject, senderName: mail.sender.name }, recipientIds);
  }

  return mail;
}

// Taslagi duzenler ve istege bagli olarak gonderir. Yalnizca hala taslak
// halindeyken (isDraft=true) ve yalnizca gonderen tarafindan cagrilabilir.
export async function updateDraft(
  mailId: string,
  input: Partial<ComposeMailInput> & { send?: boolean },
  userId: string,
) {
  const mevcut = await prisma.mail.findUnique({ where: { id: mailId } });
  if (!mevcut) throw new NotFoundError("Mesaj");
  if (mevcut.senderId !== userId) throw new ForbiddenError("Bu taslağı sadece yazarı düzenleyebilir");
  if (!mevcut.isDraft) throw new ValidationError("Gönderilmiş bir mesaj düzenlenemez");

  let recipientIds: string[] | undefined;
  if (input.recipientUserIds !== undefined || input.recipientGroups !== undefined) {
    recipientIds = await resolveRecipients(
      mevcut.organizationId,
      input.recipientUserIds ?? [],
      input.recipientGroups ?? [],
      userId,
    );
  }

  const gonder = input.send === true;
  if (gonder) {
    const nihaiAlicilar =
      recipientIds ?? (await prisma.mailRecipient.findMany({ where: { mailId }, select: { userId: true } })).map((r) => r.userId);
    if (nihaiAlicilar.length === 0) throw new ValidationError("En az bir alıcı seçilmeli");
  }

  if (recipientIds !== undefined) {
    await prisma.mailRecipient.deleteMany({ where: { mailId } });
  }

  const mail = await prisma.mail.update({
    where: { id: mailId },
    data: {
      subject: input.subject,
      body: input.body,
      isDraft: gonder ? false : undefined,
      sentAt: gonder ? new Date() : undefined,
      recipients:
        recipientIds !== undefined && recipientIds.length > 0
          ? { createMany: { data: recipientIds.map((id) => ({ userId: id })) } }
          : undefined,
    },
    select: mailListSelect,
  });

  if (gonder) {
    const alicilar = (await prisma.mailRecipient.findMany({ where: { mailId }, select: { userId: true } })).map(
      (r) => r.userId,
    );
    await notifyRecipients({ id: mail.id, subject: mail.subject, senderName: mail.sender.name }, alicilar);
  }

  return mail;
}

// Yanitla / Tumunu yanitla / Ilet. Uc mod da ayni zincire yazar; tek fark
// alici kumesinin nereden turedigi:
//   REPLY      -> yalnizca kaynagin gondereni
//   REPLY_ALL  -> gonderen + kaynagin tum alicilari (kendim haric)
//   FORWARD    -> istemcinin sectigi yeni alicilar (gecmis alicilar tasinmaz)
// Alicilar yine resolveRecipients'tan geciyor, yani uyeligi biten biri
// otomatik eleniyor: eski bir konusmayi yanitlamak, organizasyondan ayrilmis
// birine mesaj gondermenin arka kapisi olamaz.
export async function replyToMail(
  mailId: string,
  input: Partial<ReplyMailInput> & Pick<ReplyMailInput, "mode" | "body">,
  userId: string,
) {
  const kaynak = await loadMailForReply(mailId, userId);
  await requireMembership(kaynak.organizationId, userId);

  const isDraft = input.isDraft ?? false;
  const iletiliyor = input.mode === "FORWARD";

  let hamAlicilar: string[];
  let hamGruplar: RecipientGroup[];
  if (iletiliyor) {
    hamAlicilar = input.recipientUserIds ?? [];
    hamGruplar = input.recipientGroups ?? [];
  } else if (input.mode === "REPLY") {
    hamAlicilar = [kaynak.senderId];
    hamGruplar = [];
  } else {
    hamAlicilar = [kaynak.senderId, ...kaynak.recipients.map((r) => r.userId)];
    hamGruplar = [];
  }

  const recipientIds = await resolveRecipients(kaynak.organizationId, hamAlicilar, hamGruplar, userId);
  if (!isDraft && recipientIds.length === 0) {
    throw new ValidationError("En az bir alıcı seçilmeli");
  }

  const subject = prefixSubject(kaynak.subject, iletiliyor ? FORWARD_PREFIX : REPLY_PREFIX);
  const body =
    input.body +
    quoteBody({ senderName: kaynak.sender.name, sentAt: kaynak.sentAt, body: kaynak.body });

  const mail = await prisma.mail.create({
    data: {
      organizationId: kaynak.organizationId,
      senderId: userId,
      subject,
      body,
      isDraft,
      sentAt: isDraft ? null : new Date(),
      parentMailId: kaynak.id,
      threadId: kaynak.threadId ?? kaynak.id,
      recipients:
        recipientIds.length > 0 ? { createMany: { data: recipientIds.map((id) => ({ userId: id })) } } : undefined,
    },
    select: mailListSelect,
  });

  if (!isDraft) {
    await notifyRecipients({ id: mail.id, subject: mail.subject, senderName: mail.sender.name }, recipientIds);
  }

  return mail;
}

export async function listMail(organizationId: string, userId: string, folder: "inbox" | "sent" | "drafts") {
  await requireMembership(organizationId, userId);

  if (folder === "sent") {
    return prisma.mail.findMany({
      where: { organizationId, senderId: userId, isDraft: false },
      orderBy: { sentAt: "desc" },
      select: mailListSelect,
    });
  }

  if (folder === "drafts") {
    return prisma.mail.findMany({
      where: { organizationId, senderId: userId, isDraft: true },
      orderBy: { createdAt: "desc" },
      select: mailListSelect,
    });
  }

  const kayitlar = await prisma.mailRecipient.findMany({
    where: { userId, deletedAt: null, mail: { organizationId, isDraft: false } },
    orderBy: { mail: { sentAt: "desc" } },
    select: { read: true, mail: { select: mailListSelect } },
  });
  return kayitlar.map((k) => ({ ...k.mail, read: k.read }));
}

export async function getUnreadMailCount(organizationId: string, userId: string) {
  return prisma.mailRecipient.count({
    where: { userId, read: false, deletedAt: null, mail: { organizationId, isDraft: false } },
  });
}

export async function getMail(mailId: string, userId: string) {
  const mail = await prisma.mail.findUnique({
    where: { id: mailId },
    include: {
      sender: { select: { id: true, name: true } },
      attachments: true,
      recipients: { select: { userId: true, read: true, user: { select: { id: true, name: true } } } },
    },
  });
  if (!mail) throw new NotFoundError("Mesaj");

  const alici = mail.recipients.find((r) => r.userId === userId);
  const yazarMi = mail.senderId === userId;
  if (!yazarMi && !alici) throw new ForbiddenError("Bu mesaja erişim yetkiniz yok");

  if (alici && !alici.read) {
    await prisma.mailRecipient.update({
      where: { mailId_userId: { mailId, userId } },
      data: { read: true, readAt: new Date() },
    });
    alici.read = true;
  }

  const storage = supabaseAdmin;
  const attachments = storage
    ? await Promise.all(
        mail.attachments.map(async (a) => {
          const { data } = await storage.storage.from(ATTACHMENTS_BUCKET).createSignedUrl(a.storagePath, SIGNED_URL_TTL_SECONDS);
          return { ...a, downloadUrl: data?.signedUrl ?? null };
        }),
      )
    : mail.attachments.map((a) => ({ ...a, downloadUrl: null }));

  // Konusmanin diger mesajlari (bu mesaj haric). Yalnizca KULLANICININ
  // gorme hakki olanlar: gonderdikleri + alicisi oldugu mesajlar. Ayni
  // zincirdeki ama baskalari arasinda gecen bir yanit (orn. iletme)
  // sizmasin diye filtre burada, sorgu seviyesinde.
  const threadId = mail.threadId ?? mail.id;
  const thread = await prisma.mail.findMany({
    where: {
      threadId,
      id: { not: mail.id },
      isDraft: false,
      OR: [{ senderId: userId }, { recipients: { some: { userId, deletedAt: null } } }],
    },
    orderBy: { sentAt: "asc" },
    select: {
      id: true,
      subject: true,
      body: true,
      sentAt: true,
      sender: { select: { id: true, name: true } },
      _count: { select: { attachments: true } },
    },
  });

  return { ...mail, attachments, isRecipient: !!alici, thread };
}

// Baglama duyarli sil: taslak -> gercekten siler (henuz kimseye gitmedi);
// gonderilmis -> yalnizca KENDI gelen kutundan kaldirir (digerlerini etkilemez).
export async function deleteMail(mailId: string, userId: string) {
  const mail = await prisma.mail.findUnique({ where: { id: mailId }, select: { senderId: true, isDraft: true, organizationId: true } });
  if (!mail) throw new NotFoundError("Mesaj");

  if (mail.isDraft) {
    if (mail.senderId !== userId) throw new ForbiddenError("Bu taslağı sadece yazarı silebilir");
    if (supabaseAdmin) {
      const ekler = await prisma.mailAttachment.findMany({ where: { mailId }, select: { storagePath: true } });
      if (ekler.length > 0) {
        await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).remove(ekler.map((e) => e.storagePath));
      }
    }
    await prisma.mail.delete({ where: { id: mailId } });
    return { deleted: "draft" as const };
  }

  const alici = await prisma.mailRecipient.findUnique({ where: { mailId_userId: { mailId, userId } } });
  if (!alici) throw new ForbiddenError("Bu mesaj gelen kutunda değil");

  await prisma.mailRecipient.update({ where: { mailId_userId: { mailId, userId } }, data: { deletedAt: new Date() } });
  return { deleted: "inbox" as const };
}

function extensionForMime(mimeType: string): string {
  const parca = mimeType.split("/")[1];
  return parca ? parca.replace("+xml", "") : "bin";
}

export async function uploadMailAttachment(
  mailId: string,
  userId: string,
  file: { name: string; type: string; size: number; buffer: Buffer },
) {
  const mail = await prisma.mail.findUnique({ where: { id: mailId }, select: { senderId: true, isDraft: true } });
  if (!mail) throw new NotFoundError("Mesaj");
  if (mail.senderId !== userId) throw new ForbiddenError("Bu mesaja sadece yazarı ek ekleyebilir");
  if (!mail.isDraft) throw new ValidationError("Gönderilmiş bir mesaja ek eklenemez");

  if (file.size > MAX_FILE_SIZE) throw new AppError(400, "Dosya en fazla 10MB olabilir", "FILE_TOO_LARGE");
  if (!ALLOWED_MIME_TYPES.has(file.type)) throw new AppError(400, "Desteklenmeyen dosya türü", "UNSUPPORTED_FILE_TYPE");
  if (!supabaseAdmin) throw new AppError(500, "Dosya depolama yapılandırılmamış", "CONFIG_ERROR");

  const mevcutSayi = await prisma.mailAttachment.count({ where: { mailId } });
  if (mevcutSayi >= MAX_ATTACHMENTS_PER_MAIL) {
    throw new AppError(400, `Mesaj başına en fazla ${MAX_ATTACHMENTS_PER_MAIL} ek eklenebilir`, "ATTACHMENT_LIMIT_EXCEEDED");
  }

  const storagePath = `mail/${mailId}/${crypto.randomUUID()}.${extensionForMime(file.type)}`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(storagePath, file.buffer, { contentType: file.type });

  if (uploadError) {
    console.error("[mail-attachment] Supabase upload hatasi:", { storagePath, message: uploadError.message });
    throw new AppError(500, `Dosya yüklenemedi: ${uploadError.message}${storageKeyHint()}`, "UPLOAD_FAILED");
  }

  return prisma.mailAttachment.create({
    data: { mailId, fileName: file.name, storagePath, fileSize: file.size, mimeType: file.type },
  });
}

export async function deleteMailAttachment(mailId: string, attachmentId: string, userId: string) {
  const mail = await prisma.mail.findUnique({ where: { id: mailId }, select: { senderId: true, isDraft: true } });
  if (!mail) throw new NotFoundError("Mesaj");
  if (mail.senderId !== userId) throw new ForbiddenError("Bu mesajın eklerini sadece yazarı silebilir");
  if (!mail.isDraft) throw new ValidationError("Gönderilmiş bir mesajın eki silinemez");

  const ek = await prisma.mailAttachment.findUnique({ where: { id: attachmentId } });
  if (!ek || ek.mailId !== mailId) throw new NotFoundError("Ek dosya");

  if (supabaseAdmin) await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).remove([ek.storagePath]);
  await prisma.mailAttachment.delete({ where: { id: attachmentId } });
}
