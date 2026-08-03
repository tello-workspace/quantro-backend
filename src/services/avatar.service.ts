import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { AppError, NotFoundError } from "@/utils/errors";
import { supabaseAdmin, AVATARS_BUCKET, storageKeyHint } from "@/lib/supabaseAdmin";
import { compressAvatarImage } from "@/services/image-compression.service";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // bucket limitiyle ayni (5MB)
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

// MIME tipinden storage uzantisi. WebP'e donusturulen gorsellerde orijinal
// uzanti (.png/.jpg/.gif) yaniltir — depolanan dosyanin gercek turu ne ise o
// yazilir ki public URL'in Content-Type'i dogru gelsin.
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};

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

  // Gorsel sikistirmasi: 512px kare WebP, GIF'in ilk karesi alinir.
  // null donerse orijinal buffer ve mimeType kullanilir (upload asla bozulmaz).
  const processed = await compressAvatarImage(file.buffer, file.type);
  const effectiveBuffer = processed?.buffer ?? file.buffer;
  const effectiveMimeType = processed?.mimeType ?? file.type;

  // Her yuklemede yeni bir dosya adi - eski dosyayi asagida ayrica siliyoruz,
  // ayni yolu yeniden kullanmiyoruz ki CDN/tarayici cache'i eski gorseli
  // gostermeye devam etmesin.
  const extension = EXTENSION_BY_MIME[effectiveMimeType] ?? "webp";
  const storagePath = `${userId}/${crypto.randomUUID()}.${extension}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(AVATARS_BUCKET)
    .upload(storagePath, effectiveBuffer, { contentType: effectiveMimeType });

  if (uploadError) {
    // Onceden Supabase'in gercek hatasi yutuluyordu ve kullaniciya sadece
    // "Görsel yüklenemedi" donuyordu - hangi asamada patladigi (yanlis
    // anahtar / eksik bucket / RLS / mime reddi) hicbir yerde gorunmuyordu.
    // Sebebi hem sunucu loguna hem de mesaja tasiyoruz.
    console.error("[avatar] Supabase upload hatasi:", {
      bucket: AVATARS_BUCKET,
      storagePath,
      contentType: file.type,
      size: file.size,
      message: uploadError.message,
      name: uploadError.name,
    });
    throw new AppError(
      500,
      `Görsel yüklenemedi: ${uploadError.message}${storageKeyHint()}`,
      "UPLOAD_FAILED",
    );
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

// Frontend'in public/avatars/ altinda sundugu hazir avatarlar. Beyaz liste
// sart: avatarUrl dogrudan <img src> olarak basildigi icin serbest birakmak
// kullanicinin profiline istedigi dis adresi koymasina (izleme pikseli,
// referer sizintisi) izin verirdi.
export const AVATAR_PRESETS = [
  "nova",
  "orbit",
  "prism",
  "pulse",
  "ridge",
  "flux",
  "arc",
  "quartz",
  "slate",
] as const;

export type AvatarPreset = (typeof AVATAR_PRESETS)[number];

function isPreset(value: string): value is AvatarPreset {
  return (AVATAR_PRESETS as readonly string[]).includes(value);
}

export async function setPresetAvatar(userId: string, preset: string) {
  if (!isPreset(preset)) {
    throw new AppError(400, "Geçersiz avatar seçimi", "VALIDATION_ERROR");
  }

  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
  if (!existing) throw new NotFoundError("Kullanıcı");

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatarUrl: `/avatars/${preset}.svg` },
    select: { id: true, avatarUrl: true },
  });

  // Daha once Storage'a yuklenmis bir gorsel varsa birak kalmasin. Hazir
  // avatarlar Storage'a dokunmadigi icin bu adim atlanabilir olmali:
  // extractStoragePath zaten preset yollari icin null doner.
  if (existing.avatarUrl && supabaseAdmin) {
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
