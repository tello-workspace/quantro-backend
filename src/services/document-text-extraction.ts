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

// Ayristirma istek yolunda, Node'un tek is parcaciginda calisiyor. Sinir
// konulmadiginda 20MB'lik "PDF bomb" benzeri bir belge dakikalarca CPU tutup
// tum sunucuyu bekletebiliyordu. Uc sinir birlikte bu riski kapatir:
// (1) sure sinir, (2) PDF sayfa sinir, (3) cikan metnin uzunluk siniri.
const EXTRACTION_TIMEOUT_MS = 10_000;
const PDF_MAX_PAGES = 300;
const MAX_TEXT_LENGTH = 500_000;

// Ayristirma sozunu zaman asimina baglar. Sure dolarsa cagiran taraf normal
// bir hata gibi "error" doner; istek sonsuza kadar beklemez.
async function withTimeout<T>(islem: Promise<T>): Promise<T> {
  let zamanlayici: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      islem,
      new Promise<never>((_, reject) => {
        zamanlayici = setTimeout(
          () => reject(new Error(`ayristirma ${EXTRACTION_TIMEOUT_MS / 1000} saniyede tamamlanamadi`)),
          EXTRACTION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (zamanlayici) clearTimeout(zamanlayici);
  }
}

// Cikan metin kirpilmadan hem extractedText'e yaziliyor hem de /text ucundan
// tek parca JSON olarak donuyordu; sabit bir ust sinirda kesiyoruz.
function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

function isPasswordProtected(message: string): boolean {
  return /password/i.test(message);
}

export async function extractText(buffer: Buffer, mimeType: string): Promise<ExtractResult> {
  switch (mimeType) {
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      try {
        const mammoth = await import("mammoth");
        const result = await withTimeout(mammoth.extractRawText({ buffer }));
        const text = truncate(result.value.trim());
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
        const result = await withTimeout(pdfParse(buffer, { max: PDF_MAX_PAGES }));
        const text = truncate(result.text.trim());
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
      const text = truncate(buffer.toString("utf-8").trim());
      if (!text) return { text: null, reason: "empty", detail: "Dosya bos." };
      return { text, reason: "ok" };
    }
    default:
      return { text: null, reason: "unsupported" };
  }
}
