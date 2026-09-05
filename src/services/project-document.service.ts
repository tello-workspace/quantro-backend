import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, AppError } from "@/utils/errors";
import { supabaseAdmin, PROJECT_DOCUMENTS_BUCKET, storageKeyHint } from "@/lib/supabaseAdmin";
import { checkProjectAccess } from "@/services/access-control.service";
import {
  ALLOWED_MIME_TYPES,
  MAX_DOCUMENTS_PER_PROJECT,
  MAX_FILE_SIZE,
  TEXT_EXTRACTABLE_MIME_TYPES,
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

// getDocumentText, extractedText null kaldigi surece HER okumada ayni pahali
// ayristirmayi bastan deniyordu: kalici olarak metne cevrilemeyen bir belge
// (bozuk / taranmis / sifreli PDF) MCP read_document'i her cagirdiginda
// sunucuyu yeniden mesgul ediyordu. Basarisiz denemeyi surec belleginde kisa
// sure isaretleyip bu pencerede yeniden denemeyi atliyoruz; yanit yine ayni
// reason/detail ile dondugu icin disaridan gorunen davranis degismiyor.
const EXTRACTION_RETRY_COOLDOWN_MS = 10 * 60 * 1000; // 10 dk

type FailedExtraction = {
  at: number;
  reason: "unsupported" | "empty" | "error";
  detail?: string;
};

const failedExtractions = new Map<string, FailedExtraction>();

function recentExtractionFailure(documentId: string): FailedExtraction | undefined {
  const kayit = failedExtractions.get(documentId);
  if (!kayit) return undefined;
  if (Date.now() - kayit.at > EXTRACTION_RETRY_COOLDOWN_MS) {
    failedExtractions.delete(documentId);
    return undefined;
  }
  return kayit;
}

function markExtractionFailure(
  documentId: string,
  reason: FailedExtraction["reason"],
  detail?: string,
) {
  // Harita surekli buyumesin: esik asilinca suresi dolmus kayitlari temizle.
  if (failedExtractions.size > 500) {
    const simdi = Date.now();
    for (const [id, kayit] of failedExtractions) {
      if (simdi - kayit.at > EXTRACTION_RETRY_COOLDOWN_MS) failedExtractions.delete(id);
    }
  }
  failedExtractions.set(documentId, { at: Date.now(), reason, detail });
}


export async function listDocuments(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  const documents = await prisma.projectDocument.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: { uploader: { select: { id: true, name: true } } },
  });

  // extractedText'in kendisini listeye tasimadan, MCP'nin bu belgeyi
  // okuyup okuyamayacagini (yeniden deneme oncesi tahmini) UI'da
  // gosterebilmek icin bir durum ozeti cikar.
  const withStatus = documents.map(({ extractedText, ...d }) => ({
    ...d,
    textStatus: extractedText
      ? ("ok" as const)
      : TEXT_EXTRACTABLE_MIME_TYPES.has(d.mimeType)
        ? ("pending" as const)
        : ("unsupported" as const),
  }));

  const storage = supabaseAdmin;
  if (!storage) {
    return withStatus.map((d) => ({ ...d, downloadUrl: null }));
  }

  return Promise.all(
    withStatus.map(async (d) => {
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
  // (desteklenmeyen tur, bozuk dosya, taranmis PDF) yukleme yine de
  // tamamlanir; extractedText null kalir ve getDocumentText() bir sonraki
  // okumada tekrar dener (bkz. asagisi).
  const { text: extractedText } = await extractText(file.buffer, file.type);

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
// (desteklenmeyen dosya turu, cikarim hatasi ya da taranmis/bos belge) net
// bir "reason"/"detail" doner - sessizce bos metin donmez. Ayrica her zaman
// bir indirme linki eklenir ki metin cikarilamasa bile ham dosyaya erisim
// mumkun olsun.
//
// Desteklenen bir turde (pdf/docx/txt/csv) extractedText null ise -
// yukleme aninda gecici bir hata olmus olabilir - burada BIR KEZ daha
// denenir; basarili olursa sonuc DB'ye yazilip bir dahaki okuma icin
// saklanir.
export async function getDocumentText(projectId: string, documentId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  const document = await prisma.projectDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      projectId: true,
      fileName: true,
      mimeType: true,
      extractedText: true,
      storagePath: true,
    },
  });
  if (!document || document.projectId !== projectId) {
    throw new NotFoundError("Belge");
  }

  let text = document.extractedText;
  let reason: "ok" | "unsupported" | "empty" | "error" = text ? "ok" : "unsupported";
  let detail: string | undefined;

  if (!text && TEXT_EXTRACTABLE_MIME_TYPES.has(document.mimeType) && supabaseAdmin) {
    // Yakin zamanda denenip basarisiz olduysa indirme + ayristirmayi hic
    // baslatma; son denemenin sonucunu oldugu gibi don.
    const sonHata = recentExtractionFailure(document.id);
    if (sonHata) {
      reason = sonHata.reason;
      detail = sonHata.detail;
    } else {
      const { data: fileData, error: downloadError } = await supabaseAdmin.storage
        .from(PROJECT_DOCUMENTS_BUCKET)
        .download(document.storagePath);

      if (downloadError) {
        reason = "error";
        detail = `Dosya depodan okunamadi: ${downloadError.message}`;
        markExtractionFailure(document.id, reason, detail);
      } else {
        const buffer = Buffer.from(await fileData.arrayBuffer());
        const retry = await extractText(buffer, document.mimeType);
        reason = retry.reason;
        detail = retry.detail;
        if (retry.text) {
          text = retry.text;
          await prisma.projectDocument.update({
            where: { id: document.id },
            data: { extractedText: retry.text },
          });
        } else if (retry.reason !== "ok") {
          markExtractionFailure(document.id, retry.reason, retry.detail);
        }
      }
    }
  }

  const downloadUrl = supabaseAdmin
    ? (
        await supabaseAdmin.storage
          .from(PROJECT_DOCUMENTS_BUCKET)
          .createSignedUrl(document.storagePath, SIGNED_URL_TTL_SECONDS)
      ).data?.signedUrl ?? null
    : null;

  return {
    id: document.id,
    fileName: document.fileName,
    mimeType: document.mimeType,
    text,
    reason: text ? "ok" : reason,
    detail: text ? undefined : detail,
    downloadUrl,
  };
}
