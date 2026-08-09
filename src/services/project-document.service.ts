import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, AppError } from "@/utils/errors";
import { supabaseAdmin, PROJECT_DOCUMENTS_BUCKET, storageKeyHint } from "@/lib/supabaseAdmin";
import {
  ALLOWED_MIME_TYPES,
  MAX_DOCUMENTS_PER_PROJECT,
  MAX_FILE_SIZE,
} from "@/lib/document-policy";
import { extractText } from "@/services/document-text-extraction";

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 saat

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
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

// Projeye -> organizasyona erisim kontrolu (board.service.ts ile ayni desen)
async function checkProjectAccess(projectId: string, userId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, organization: { members: { some: { userId } } } },
    select: { organization: { select: { members: { where: { userId }, select: { role: true } } } } },
  });

  if (project) return { role: project.organization.members[0].role };

  const exists = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!exists) throw new NotFoundError("Proje");
  throw new ForbiddenError("Bu projeye erişim yetkiniz yok");
}

export async function listDocuments(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  const documents = await prisma.projectDocument.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: { uploader: { select: { id: true, name: true } } },
    omit: { extractedText: true },
  });

  const storage = supabaseAdmin;
  if (!storage) {
    return documents.map((d) => ({ ...d, downloadUrl: null }));
  }

  return Promise.all(
    documents.map(async (d) => {
      const { data } = await storage.storage
        .from(PROJECT_DOCUMENTS_BUCKET)
        .createSignedUrl(d.storagePath, SIGNED_URL_TTL_SECONDS);
      return { ...d, downloadUrl: data?.signedUrl ?? null };
    }),
  );
}

export async function uploadDocument(
  projectId: string,
  userId: string,
  file: { name: string; type: string; size: number; buffer: Buffer },
) {
  await checkProjectAccess(projectId, userId);

  if (file.size > MAX_FILE_SIZE) {
    throw new AppError(400, "Dosya en fazla 20MB olabilir", "FILE_TOO_LARGE");
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new AppError(400, "Desteklenmeyen dosya türü", "UNSUPPORTED_FILE_TYPE");
  }
  if (!supabaseAdmin) {
    throw new AppError(500, "Dosya depolama yapılandırılmamış", "CONFIG_ERROR");
  }

  const existingCount = await prisma.projectDocument.count({ where: { projectId } });
  if (existingCount >= MAX_DOCUMENTS_PER_PROJECT) {
    throw new AppError(
      400,
      `Proje başına en fazla ${MAX_DOCUMENTS_PER_PROJECT} belge eklenebilir`,
      "DOCUMENT_LIMIT_EXCEEDED",
    );
  }

  const storagePath = `${projectId}/${crypto.randomUUID()}.${extensionForMime(file.type)}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(PROJECT_DOCUMENTS_BUCKET)
    .upload(storagePath, file.buffer, { contentType: file.type });

  if (uploadError) {
    console.error("[project-document] Supabase upload hatasi:", {
      bucket: PROJECT_DOCUMENTS_BUCKET,
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

  // Metin cikarimi yukleme aninda bir kez yapilir ve saklanir - MCP okuma
  // istekleri boylece her seferinde docx/pdf parse etmez. Basarisiz olursa
  // (desteklenmeyen tur, bozuk dosya) yukleme yine de tamamlanir; sadece
  // extractedText null kalir.
  const extractedText = await extractText(file.buffer, file.type);

  const document = await prisma.projectDocument.create({
    data: {
      projectId,
      uploaderId: userId,
      fileName: file.name,
      storagePath,
      fileSize: file.buffer.length,
      mimeType: file.type,
      extractedText,
    },
    include: { uploader: { select: { id: true, name: true } } },
    omit: { extractedText: true },
  });

  return document;
}

export async function deleteDocument(projectId: string, documentId: string, userId: string) {
  const { role } = await checkProjectAccess(projectId, userId);

  const document = await prisma.projectDocument.findUnique({ where: { id: documentId } });
  if (!document || document.projectId !== projectId) {
    throw new NotFoundError("Belge");
  }

  if (document.uploaderId !== userId && role !== "ADMIN") {
    throw new ForbiddenError("Bu belgeyi yalnızca yükleyen kişi veya admin silebilir");
  }

  if (supabaseAdmin) {
    await supabaseAdmin.storage.from(PROJECT_DOCUMENTS_BUCKET).remove([document.storagePath]);
  }

  await prisma.projectDocument.delete({ where: { id: documentId } });
}

// MCP server'in read_document araci bunu cagirir. extractedText null ise
// (desteklenmeyen dosya turu ya da cikarim basarisiz oldu) net bir mesaj
// doner - sessizce bos metin donmez.
export async function getDocumentText(projectId: string, documentId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  const document = await prisma.projectDocument.findUnique({
    where: { id: documentId },
    select: { id: true, projectId: true, fileName: true, mimeType: true, extractedText: true },
  });
  if (!document || document.projectId !== projectId) {
    throw new NotFoundError("Belge");
  }

  return {
    id: document.id,
    fileName: document.fileName,
    mimeType: document.mimeType,
    text: document.extractedText,
  };
}
