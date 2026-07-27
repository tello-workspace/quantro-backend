import { NextRequest } from "next/server";
import { reviewChangeRequestSchema } from "@/schemas/change-request.schema";
import * as changeRequestService from "@/services/change-request.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// Talebi sonuclandirir. ?action=approve | reject
// Onayda degisiklik otomatik uygulanir, redde payload kullanilmaz.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;

    const action = new URL(request.url).searchParams.get("action");
    if (action !== "approve" && action !== "reject") {
      return errorResponse("action 'approve' veya 'reject' olmalı", 400, "VALIDATION_ERROR");
    }

    const body = await validateBody(request, reviewChangeRequestSchema);
    if (body instanceof Response) return body;

    const sonuc =
      action === "approve"
        ? await changeRequestService.approveRequest(id, user.id, body.note)
        : await changeRequestService.rejectRequest(id, user.id, body.note);

    return successResponse(sonuc);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    console.error("[REQUEST REVIEW] Hata:", error);
    return errorResponse("Talep değerlendirilemedi", 500, "INTERNAL_ERROR");
  }
}
