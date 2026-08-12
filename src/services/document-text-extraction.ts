// Yuklenen proje belgesinden duz metin cikarir. Yukleme aninda BIR KEZ
// calisir ve sonuc ProjectDocument.extractedText'e yazilir — MCP server'in
// read_document cagrisinda her seferinde docx/pdf yeniden parse edilmez.
// getDocumentText() extractedText null geldiginde bunu bir kez daha dener
// (bkz. project-document.service.ts) ve bu sefer "reason"/"detail" ile
// donen sonucu kullaniciya/MCP'ye acikca aktarir.
//
// .doc (eski Word formati), gorseller, zip ve xls/xlsx ALLOWED_MIME_TYPES'ta
// kabul edilir ama burada metne cevrilemez -> reason "unsupported".

export type ExtractReason = "ok" | "unsupported" | "empty" | "error";

export interface ExtractResult {
  text: string | null;
  reason: ExtractReason;
  // Kullaniciya/MCP'ye gosterilebilecek kisa, Turkce aciklama. "ok" ve
  // "unsupported" icin bos birakilir (cagiran taraf zaten mimeType'tan
  // "desteklenmiyor" mesajini kendi uretiyor).
  detail?: string;
}

function isPasswordProtected(message: string): boolean {
  return /password/i.test(message);
}

export async function extractText(buffer: Buffer, mimeType: string): Promise<ExtractResult> {
  switch (mimeType) {
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      try {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ buffer });
        const text = result.value.trim();
        if (!text) return { text: null, reason: "empty", detail: "Belge metin icermiyor (bos olabilir)." };
        return { text, reason: "ok" };
      } catch (error) {
        const message = (error as Error).message;
        console.error("[document-text-extraction] docx cikarma hatasi:", { message });
        return { text: null, reason: "error", detail: `Word belgesi okunamadi: ${message}` };
      }
    }
    case "application/pdf": {
      try {
        const pdfParse = (await import("pdf-parse")).default;
        const result = await pdfParse(buffer);
        const text = result.text.trim();
        if (!text) {
          return {
            text: null,
            reason: "empty",
            detail: "PDF'te metin katmani bulunamadi — taranmis/gorsel tabanli bir belge olabilir.",
          };
        }
        return { text, reason: "ok" };
      } catch (error) {
        const message = (error as Error).message;
        console.error("[document-text-extraction] pdf cikarma hatasi:", { message });
        return {
          text: null,
          reason: "error",
          detail: isPasswordProtected(message)
            ? "PDF sifre korumali oldugu icin metni cikarilamadi."
            : `PDF okunamadi (bozuk veya desteklenmeyen yapida olabilir): ${message}`,
        };
      }
    }
    case "text/plain":
    case "text/csv": {
      const text = buffer.toString("utf-8").trim();
      if (!text) return { text: null, reason: "empty", detail: "Dosya bos." };
      return { text, reason: "ok" };
    }
    default:
      return { text: null, reason: "unsupported" };
  }
}
