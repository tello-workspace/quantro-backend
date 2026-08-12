import { NextRequest } from "next/server";
import { applyImportSchema } from "@/schemas/import.schema";
import * as importService from "@/services/import.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, applyImportSchema);
    if (body instanceof Response) return body;

    const result = await importService.applyImport(
      id,
      body.format,
      body.fileContent,
      body.columnMapping,
      body.userMapping,
      user.id,
    );
    return successResponse(result, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "İçe aktarma uygulanamadı");
  }
}
