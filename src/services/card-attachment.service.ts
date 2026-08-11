import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, AppError } from "@/utils/errors";
import { supabaseAdmin, ATTACHMENTS_BUCKET, storageKeyHint } from "@/lib/supabaseAdmin";
import { checkCardAccess } from "@/services/access-control.service";
import { broadcastToProject, SocketEvents } from "@/server/socket";
import {
  ALLOWED_MIME_TYPES,
  MAX_ATTACHMENTS_PER_CARD,
  MAX_FILE_SIZE,
} from "@/lib/attachment-policy";
import { compressImage } from "@/services/image-compression.service";

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 saat

// MIME tipinden storage uzantisini turer. WebP'e donusturulen gorsellerde
// orijinal uzanti (.png/.jpg) yaniltir — depolanan dosyanin gercek turu ne ise
// o yazilir, boylece signed-URL indirmede Content-Type dogru gelir.
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/zip": "zip",
};

function extensionForMime(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType] ?? "bin";
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

  const existingCount = await prisma.cardAttachment.count({ where: { cardId } });
  if (existingCount >= MAX_ATTACHMENTS_PER_CARD) {
    throw new AppError(400, `Kart başına en fazla ${MAX_ATTACHMENTS_PER_CARD} ek eklenebilir`, "ATTACHMENT_LIMIT_EXCEEDED");
  }

  // Gorsel sikistirmasi: JPEG/PNG -> WebP, buyuk WebP -> boyutlandirma.
  // null donerse orijinal buffer ve mimeType kullanilir (asla upload bozulmaz).
  const processed = await compressImage(file.buffer, file.type);
  const effectiveBuffer = processed?.buffer ?? file.buffer;
  const effectiveMimeType = processed?.mimeType ?? file.type;

  const storagePath = `${cardId}/${crypto.randomUUID()}.${extensionForMime(effectiveMimeType)}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(storagePath, effectiveBuffer, { contentType: effectiveMimeType });

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
    throw new AppError(
      500,
      `Dosya yüklenemedi: ${uploadError.message}${storageKeyHint()}`,
      "UPLOAD_FAILED",
    );
  }

  const attachment = await prisma.cardAttachment.create({
    data: {
      cardId,
      uploaderId: userId,
      fileName: file.name,
      storagePath,
      fileSize: effectiveBuffer.length,
      mimeType: effectiveMimeType,
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
