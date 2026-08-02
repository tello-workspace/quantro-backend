import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { compressImage, compressAvatarImage } from "@/services/image-compression.service";

// Supabase/DB gerektirmeyen saf birim testleri: sadece buffer + mimeType girer.

async function makePngBuffer(width = 512, height = 512): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 120, b: 60, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

async function makeJpegBuffer(width = 4000, height = 3000): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 90, b: 150 },
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe("image-compression.service", () => {
  it("PNG -> WebP'e donusturur ve kucultur", async () => {
    const original = await makePngBuffer(1024, 1024);
    const result = await compressImage(original, "image/png");

    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/webp");
    expect(result!.buffer.length).toBeLessThan(original.length);
  });

  it("kucuk gorseli asla sisirmez (orijinalden buyuk cikarsa null)", async () => {
    // Tek renkli, zaten cok kucuk bir PNG: WebP yeniden kodlamasi buyuk olabilir
    const tiny = await makePngBuffer(64, 64);
    const result = await compressImage(tiny, "image/png");

    // Sadece orijinalden kucukse kabul et; aksi halde null (passthrough)
    if (result) {
      expect(result.buffer.length).toBeLessThan(tiny.length);
    }
  });

  it("buyuk JPEG'i 2048px sinirina olcekler", async () => {
    const original = await makeJpegBuffer(4000, 3000);
    const result = await compressImage(original, "image/jpeg");

    expect(result).not.toBeNull();
    const meta = await sharp(result!.buffer).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2048);
    expect(result!.mimeType).toBe("image/webp");
  });

  it("GIF ve SVG'e dokunmaz (null)", async () => {
    const gif = Buffer.from("GIF89a fake content");
    expect(await compressImage(gif, "image/gif")).toBeNull();

    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(await compressImage(svg, "image/svg+xml")).toBeNull();
  });

  it("gorsel olmayan MIME'ler icin null doner", async () => {
    const pdf = Buffer.from("%PDF-1.4 fake");
    expect(await compressImage(pdf, "application/pdf")).toBeNull();
  });

  it("bozuk baytlarda hata firlatmaz, null doner", async () => {
    const garbage = Buffer.from("bu bir gorsel degil, rastgele baytlar");
    const result = await compressImage(garbage, "image/png");
    // Yakalanamayan hata olmadan null (veya asla kabul edilmez) donmeli
    expect(result).toBeNull();
  });
});

describe("compressAvatarImage", () => {
  it("buyuk JPEG'i 512px kare WebP'e donusturur ve kucultur", async () => {
    const original = await sharp({
      create: { width: 2000, height: 1200, channels: 3, background: { r: 30, g: 90, b: 150 } },
    })
      .jpeg({ quality: 95 })
      .toBuffer();

    const result = await compressAvatarImage(original, "image/jpeg");

    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/webp");
    const meta = await sharp(result!.buffer).metadata();
    // cover kirpma: kare cikmali (bir kenar 512, digeri de 512'yi gecemez)
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(512);
    expect(meta.width).toBe(meta.height); // kare
    expect(result!.buffer.length).toBeLessThan(original.length);
  });

  it("animasyonlu GIF'in ilk karesini WebP'e cevirir", async () => {
    const gifBuffer = await sharp({
      create: { width: 200, height: 150, channels: 4, background: { r: 10, g: 200, b: 80, alpha: 1 } },
    })
      .gif()
      .toBuffer();

    const result = await compressAvatarImage(gifBuffer, "image/gif");

    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/webp");
    // WebP magic: "RIFF" + 4 bayt + "WEBP"
    const magic = result!.buffer.subarray(0, 12).toString("ascii");
    expect(magic).toMatch(/^RIFF....WEBP/);
  });

  it("kucuk gorseli asla sisirmez (buyurse null)", async () => {
    const tiny = await sharp({
      create: { width: 48, height: 48, channels: 4, background: { r: 120, g: 120, b: 120, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const result = await compressAvatarImage(tiny, "image/png");
    if (result) {
      expect(result.buffer.length).toBeLessThan(tiny.length);
    }
  });

  it("SVG ve non-image icin null doner", async () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(await compressAvatarImage(svg, "image/svg+xml")).toBeNull();

    const pdf = Buffer.from("%PDF-1.4 fake");
    expect(await compressAvatarImage(pdf, "application/pdf")).toBeNull();
  });

  it("bozuk baytlarda hata firlatmaz, null doner", async () => {
    const garbage = Buffer.from("rastgele bozuk baytlar, gorsel degil");
    const result = await compressAvatarImage(garbage, "image/jpeg");
    expect(result).toBeNull();
  });
});
