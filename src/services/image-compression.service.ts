import sharp from "sharp";
import {
  COMPRESSIBLE_IMAGE_TYPES,
  IMAGE_QUALITY,
  MAX_IMAGE_DIMENSION,
  RESIZE_ONLY_IMAGE_TYPES,
} from "@/lib/attachment-policy";

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

  // GIF/SVG/non-image: dokunma
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
