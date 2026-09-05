import { NextRequest } from "next/server";
import { applyImportSchema } from "@/schemas/import.schema";
import * as importService from "@/services/import.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { checkIdempotency, clearIdempotency, failIdempotency } from "@/middleware/idempotency";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, applyImportSchema);
    if (body instanceof Response) return body;

    // Idempotency check — applyImport tek istekte yuzlerce kart yaratiyor ve
    // saniyeler suruyor; koruma olmadan sabirsiz bir cift tiklama (ya da
    // tarayici/proxy'nin istegi yeniden denemesi) ayni panoyu iki kez
    // olusturuyor. Geri alma yolu olmadigi icin temizlik elle yapiliyor.
    const idem = checkIdempotency(request, user.id, body);
    if (idem instanceof Response) return idem;

    try {
      const result = await importService.applyImport(
        id,
        body.format,
        body.fileContent,
        body.columnMapping,
        body.userMapping,
        user.id,
      );

      clearIdempotency(idem.key);
      return successResponse(result, 201);
    } catch (err) {
      failIdempotency(idem.key);
      throw err;
    }
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "İçe aktarma uygulanamadı");
  }
}
