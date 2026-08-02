import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, AppError } from "@/utils/errors";
import { supabaseAdmin, ATTACHMENTS_BUCKET } from "@/lib/supabaseAdmin";
import { broadcastToProject, SocketEvents } from "@/server/socket";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // bucket limitiyle ayni (10MB)
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 saat

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
]);

// Kartın kolonuna → projesine → organizasyonuna erişim kontrolü (comment.service.ts ile ayni desen)
async function checkCardAccess(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { column: { select: { projectId: true, project: { select: { organizationId: true } } } } },
  });
  if (!card) throw new NotFoundError("Kart");

  const member = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: card.column.project.organizationId,
        userId,
      },
    },
  });
  if (!member) throw new ForbiddenError("Bu karta erişim yetkiniz yok");

  return { projectId: card.column.projectId, role: member.role };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
}

export async function listAttachments(cardId: string, userId: string) {
  await checkCardAccess(cardId, userId);

  const attachments = await prisma.cardAttachment.findMany({
    where: { cardId },
    orderBy: { createdAt: "desc" },
    include: { uploader: { select: { id: true, name: true } } },
  });

  const storage = supabaseAdmin;
  if (!storage) {
    return attachments.map((a) => ({ ...a, downloadUrl: null }));
  }

  return Promise.all(
    attachments.map(async (a) => {
      const { data } = await storage.storage
        .from(ATTACHMENTS_BUCKET)
        .createSignedUrl(a.storagePath, SIGNED_URL_TTL_SECONDS);
      return { ...a, downloadUrl: data?.signedUrl ?? null };
    }),
  );
}

export async function uploadAttachment(
  cardId: string,
  userId: string,
  file: { name: string; type: string; size: number; buffer: Buffer },
) {
  const { projectId } = await checkCardAccess(cardId, userId);

  if (file.size > MAX_FILE_SIZE) {
    throw new AppError(400, "Dosya en fazla 10MB olabilir", "FILE_TOO_LARGE");
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new AppError(400, "Desteklenmeyen dosya türü", "UNSUPPORTED_FILE_TYPE");
  }
  if (!supabaseAdmin) {
    throw new AppError(500, "Dosya depolama yapılandırılmamış", "CONFIG_ERROR");
  }

  const storagePath = `${cardId}/${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(storagePath, file.buffer, { contentType: file.type });

  if (uploadError) {
    // Gercek Supabase hatasini yutma - bkz. avatar.service.ts'teki ayni not.
    console.error("[attachment] Supabase upload hatasi:", {
      bucket: ATTACHMENTS_BUCKET,
      storagePath,
      contentType: file.type,
      size: file.size,
      message: uploadError.message,
      name: uploadError.name,
    });
    throw new AppError(500, `Dosya yüklenemedi: ${uploadError.message}`, "UPLOAD_FAILED");
  }

  const attachment = await prisma.cardAttachment.create({
    data: {
      cardId,
      uploaderId: userId,
      fileName: file.name,
      storagePath,
      fileSize: file.size,
      mimeType: file.type,
    },
    include: { uploader: { select: { id: true, name: true } } },
  });

  broadcastToProject(projectId, SocketEvents.ATTACHMENT_ADDED, {
    id: attachment.id,
    cardId,
    uploaderId: userId,
    uploaderName: attachment.uploader.name,
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
    mimeType: attachment.mimeType,
    createdAt: attachment.createdAt.toISOString(),
  });

  return attachment;
}

export async function deleteAttachment(cardId: string, attachmentId: string, userId: string) {
  const { projectId, role } = await checkCardAccess(cardId, userId);

  const attachment = await prisma.cardAttachment.findUnique({ where: { id: attachmentId } });
  if (!attachment || attachment.cardId !== cardId) {
    throw new NotFoundError("Ek dosya");
  }

  if (attachment.uploaderId !== userId && role !== "ADMIN") {
    throw new ForbiddenError("Bu eki yalnızca yükleyen kişi veya admin silebilir");
  }

  if (supabaseAdmin) {
    await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).remove([attachment.storagePath]);
  }

  await prisma.cardAttachment.delete({ where: { id: attachmentId } });

  broadcastToProject(projectId, SocketEvents.ATTACHMENT_DELETED, { cardId, attachmentId });
}
