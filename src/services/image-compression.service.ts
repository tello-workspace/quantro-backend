import sharp from "sharp";
import {
  COMPRESSIBLE_IMAGE_TYPES,
  IMAGE_QUALITY,
  MAX_IMAGE_DIMENSION,
  RESIZE_ONLY_IMAGE_TYPES,
} from "@/lib/attachment-policy";

// Avatar ozel politika: kare, kucuk (512px), daha yuksek kalite.
// Kart eklerinden farkli olarak GIF'in ILK KARESI WebP'e cevrilir —
// animasyonlu avatar kucuk bir karede anlamsizdir ve 5MB GIF kota yer.
const MAX_AVATAR_DIMENSION = 512;
const AVATAR_QUALITY = 85;

// Avatar icin kabul edilen kaynak MIME'ler. SVG/non-image burada kabul edilmez
// (avatar.service.ts zaten kendi ALLOWED_MIME_TYPES'inda kistliyor, bu sadece
// fonksiyonun dar sözlesmesi).
const AVATAR_COMPRESSIBLE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export interface CompressedImage {
  buffer: Buffer;
  mimeType: string;
}

// JPEG/PNG -> WebP'e sikistirir, buyuk WebP'leri boyutlandirir.
//
// Kritik kurallar:
// - CIKTI ASLA ORJINALDEN BUYUK OLAMAZ: sadece daha kucuk ciktigi takdirde
//   yeni buffer kabul edilir, aksi halde null doner (passthrough).
// - HATA ASLA YUKLEMEYI BOZMAZ: sharp ne atarsa atsin (bozuk bayt, decode
//   hatasi, bellek limiti vb.) try/catch -> null, upload orijinalle devam eder.
export async function compressImage(
  buffer: Buffer,
  mimeType: string,
): Promise<CompressedImage | null> {
  if (COMPRESSIBLE_IMAGE_TYPES.has(mimeType)) {
    return compressibleToWebp(buffer);
  }

  if (RESIZE_ONLY_IMAGE_TYPES.has(mimeType)) {
    return resizeOnlyIfOversize(buffer);
  }

  // GIF/non-image: dokunma (SVG artik allowlist'te degil)
  return null;
}

async function compressibleToWebp(buffer: Buffer): Promise<CompressedImage | null> {
  try {
    const resized = sharp(buffer)
      .rotate() // EXIF oryantasyonunu uygula (telefonda dik cekilen fotograflar)
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true, // kucuk gorseli asla buyutme
      })
      .webp({ quality: IMAGE_QUALITY });

    const output = await resized.toBuffer();

    // Sadece gercekten kuculduyse kabul et; aksi halde orijinal gorsel kalir
    if (output.length < buffer.length) {
      return { buffer: output, mimeType: "image/webp" };
    }
    return null;
  } catch (error) {
    console.error("[image-compression] WebP sikistirma basarisiz, orijinal kullanilacak:", error);
    return null;
  }
}

async function resizeOnlyIfOversize(buffer: Buffer): Promise<CompressedImage | null> {
  try {
    const metadata = await sharp(buffer).metadata();
    if (!metadata.width || !metadata.height) return null;

    const longestEdge = Math.max(metadata.width, metadata.height);
    if (longestEdge <= MAX_IMAGE_DIMENSION) return null;

    const resized = await sharp(buffer)
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: IMAGE_QUALITY })
      .toBuffer();

    if (resized.length < buffer.length) {
      return { buffer: resized, mimeType: "image/webp" };
    }
    return null;
  } catch (error) {
    console.error("[image-compression] WebP boyutlandirma basarisiz, orijinal kullanilacak:", error);
    return null;
  }
}

// Avatar sikistirmasi: kare WebP'e donusturur, GIF'in ilk karesini alir.
//
// Kart eki compressImage'den farkli kurallar:
// - fit: "cover" — avatar her zaman kare (512x512) olur, tasan kisim kirpilir
// - GIF: animated: false -> ilk kare, animasyon avatar olarak tutulmaz
// - CIKTI ASLA ORJINALDEN BUYUK OLAMAZ + hata asla yuklemeyi bozmaz
export async function compressAvatarImage(
  buffer: Buffer,
  mimeType: string,
): Promise<CompressedImage | null> {
  if (!AVATAR_COMPRESSIBLE_MIME_TYPES.has(mimeType)) return null;

  try {
    const output = await sharp(buffer, { animated: false })
      .rotate() // EXIF oryantasyonu (telefonda dik cekilen fotograflar)
      .resize({
        width: MAX_AVATAR_DIMENSION,
        height: MAX_AVATAR_DIMENSION,
        fit: "cover", // kare kirpma: oranlar korunur, tasan kismi keser
        position: "centre",
        withoutEnlargement: true, // kucuk gorseli asla buyutme
      })
      .webp({ quality: AVATAR_QUALITY })
      .toBuffer();

    if (output.length < buffer.length) {
      return { buffer: output, mimeType: "image/webp" };
    }
    return null;
  } catch (error) {
    console.error("[image-compression] Avatar sikistirma basarisiz, orijinal kullanilacak:", error);
    return null;
  }
}
