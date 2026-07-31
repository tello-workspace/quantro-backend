import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { AppError, NotFoundError } from "@/utils/errors";
import { supabaseAdmin, AVATARS_BUCKET } from "@/lib/supabaseAdmin";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // bucket limitiyle ayni (5MB)
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export async function uploadAvatar(
  userId: string,
  file: { name: string; type: string; size: number; buffer: Buffer },
) {
  if (file.size > MAX_FILE_SIZE) {
    throw new AppError(400, "Görsel en fazla 5MB olabilir", "FILE_TOO_LARGE");
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new AppError(400, "Desteklenmeyen görsel türü (png/jpeg/webp/gif olmalı)", "UNSUPPORTED_FILE_TYPE");
  }
  if (!supabaseAdmin) {
    throw new AppError(500, "Dosya depolama yapılandırılmamış", "CONFIG_ERROR");
  }

  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
  if (!existing) throw new NotFoundError("Kullanıcı");

  const extension = file.type.split("/")[1] ?? "png";
  // Her yuklemede yeni bir dosya adi - eski dosyayi asagida ayrica siliyoruz,
  // ayni yolu yeniden kullanmiyoruz ki CDN/tarayici cache'i eski gorseli
  // gostermeye devam etmesin.
  const storagePath = `${userId}/${crypto.randomUUID()}.${extension}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(AVATARS_BUCKET)
    .upload(storagePath, file.buffer, { contentType: file.type });

  if (uploadError) {
    throw new AppError(500, "Görsel yüklenemedi", "UPLOAD_FAILED");
  }

  const { data: publicUrlData } = supabaseAdmin.storage.from(AVATARS_BUCKET).getPublicUrl(storagePath);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatarUrl: publicUrlData.publicUrl },
    select: { id: true, avatarUrl: true },
  });

  // Eski gorseli temizle - basarisiz olursa sessizce gec, kullanicinin
  // yeni yuklemesini engellemesin.
  if (existing.avatarUrl) {
    const oldPath = extractStoragePath(existing.avatarUrl);
    if (oldPath) {
      await supabaseAdmin.storage.from(AVATARS_BUCKET).remove([oldPath]).catch(() => {});
    }
  }

  return updated;
}

export async function removeAvatar(userId: string) {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
  if (!existing) throw new NotFoundError("Kullanıcı");

  if (existing.avatarUrl && supabaseAdmin) {
    const oldPath = extractStoragePath(existing.avatarUrl);
    if (oldPath) {
      await supabaseAdmin.storage.from(AVATARS_BUCKET).remove([oldPath]).catch(() => {});
    }
  }

  return prisma.user.update({
    where: { id: userId },
    data: { avatarUrl: null },
    select: { id: true, avatarUrl: true },
  });
}

function extractStoragePath(publicUrl: string): string | null {
  const marker = `/object/public/${AVATARS_BUCKET}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return null;
  return publicUrl.slice(idx + marker.length);
}
