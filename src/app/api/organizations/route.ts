import { NextRequest } from "next/server";
import { createOrganizationSchema } from "@/schemas/organization.schema";
import * as organizationService from "@/services/organization.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { checkIdempotency, clearIdempotency, failIdempotency } from "@/middleware/idempotency";
import { AppError } from "@/utils/errors";

export async function GET(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const orgs = await organizationService.getMyOrganizations(user.id);
    return successResponse(orgs);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Organizasyonlar alınamadı", 500, "INTERNAL_ERROR");
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const body = await validateBody(request, createOrganizationSchema);
    if (body instanceof Response) return body;

    // Idempotency check
    const idem = checkIdempotency(request, user.id, body);
    if (idem instanceof Response) return idem;

    try {
      const org = await organizationService.createOrganization(body, user.id);
      clearIdempotency(idem.key);
      return successResponse(org, 201);
    } catch (err) {
      failIdempotency(idem.key);
      throw err;
    }
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Organizasyon oluşturulamadı", 500, "INTERNAL_ERROR");
  }
}
