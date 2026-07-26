import { NextRequest } from "next/server";
import { attachLabelSchema } from "@/schemas/label.schema";
import * as labelService from "@/services/label.service";
import { successResponse, errorResponse } from "@/utils/api-response";
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
    const body = await validateBody(request, attachLabelSchema);
    if (body instanceof Response) return body;

    // Idempotency check — aynı karta aynı etiketi 2 kere eklemeyi engelle
    const idem = checkIdempotency(request, user.id, body);
    if (idem instanceof Response) return idem;

    try {
      const cardLabel = await labelService.attachLabelToCard(id, body.labelId, user.id);
      clearIdempotency(idem.key);
      return successResponse(cardLabel, 201);
    } catch (err) {
      failIdempotency(idem.key);
      throw err;
    }
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Etiket eklenemedi", 500, "INTERNAL_ERROR");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, attachLabelSchema);
    if (body instanceof Response) return body;

    await labelService.removeLabelFromCard(id, body.labelId, user.id);
    return successResponse({ deleted: true });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Etiket çıkarılamadı", 500, "INTERNAL_ERROR");
  }
}
