import { NextRequest } from "next/server";
import {
  createChangeRequestSchema,
  listChangeRequestsSchema,
} from "@/schemas/change-request.schema";
import * as changeRequestService from "@/services/change-request.service";
import { successResponse, errorResponse, validationError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// Talep listesi. Admin organizasyonun tum taleplerini gorur,
// uye yalnizca kendi gonderdiklerini.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;

    const { searchParams } = new URL(request.url);
    const parsed = listChangeRequestsSchema.safeParse({
      status: searchParams.get("status") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) return validationError(parsed.error);

    const requests = await changeRequestService.listRequests(id, parsed.data, user.id);
    return successResponse(requests);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Talepler alınamadı", 500, "INTERNAL_ERROR");
  }
}

// Yeni talep olusturma (uye)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;

    const body = await validateBody(request, createChangeRequestSchema);
    if (body instanceof Response) return body;

    const created = await changeRequestService.createRequest(body, user.id, id);
    return successResponse(created, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    console.error("[REQUESTS] Hata:", error);
    return errorResponse("Talep oluşturulamadı", 500, "INTERNAL_ERROR");
  }
}
