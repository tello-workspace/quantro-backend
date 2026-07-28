import { NextRequest } from "next/server";
import * as searchService from "@/services/search.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q") ?? "";

    if (q.trim().length < 2) {
      return errorResponse("Arama en az 2 karakter olmalı", 400, "VALIDATION_ERROR");
    }

    const result = await searchService.searchOrganization(id, user.id, q);
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Arama yapılamadı", 500, "INTERNAL_ERROR");
  }
}
