// Yuklenen proje belgesinden duz metin cikarir. Yukleme aninda BIR KEZ
// calisir ve sonuc ProjectDocument.extractedText'e yazilir — MCP server'in
// read_document cagrisinda her seferinde docx/pdf yeniden parse edilmez.
//
// .doc (eski Word formati), gorseller, zip ve xls/xlsx ALLOWED_MIME_TYPES'ta
// kabul edilir ama burada metne cevrilemez; bu durumda null donup route
// kullaniciya "metin cikarilamadi" bilgisini acikca veriyor (sessizce bos
// string yazmak yerine).
export async function extractText(buffer: Buffer, mimeType: string): Promise<string | null> {
  try {
    switch (mimeType) {
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ buffer });
        return result.value.trim() || null;
      }
      case "application/pdf": {
        const pdfParse = (await import("pdf-parse")).default;
        const result = await pdfParse(buffer);
        return result.text.trim() || null;
      }
      case "text/plain":
      case "text/csv":
        return buffer.toString("utf-8").trim() || null;
      default:
        return null;
    }
  } catch (error) {
    console.error("[document-text-extraction] Metin cikarilamadi:", {
      mimeType,
      message: (error as Error).message,
    });
    return null;
  }
}
