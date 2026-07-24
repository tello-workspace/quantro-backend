import { NextRequest } from "next/server";
import { createCommentSchema } from "@/schemas/comment.schema";
import * as commentService from "@/services/comment.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { checkIdempotency, clearIdempotency, failIdempotency } from "@/middleware/idempotency";
import { AppError } from "@/utils/errors";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const comments = await commentService.getComments(id, user.id);
    return successResponse(comments);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Yorumlar alınamadı", 500, "INTERNAL_ERROR");
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, createCommentSchema);
    if (body instanceof Response) return body;

    // Idempotency check
    const idem = checkIdempotency(request, user.id, body);
    if (idem instanceof Response) return idem;

    try {
      const comment = await commentService.createComment(id, body, user.id);
      clearIdempotency(idem.key);
      return successResponse(comment, 201);
    } catch (err) {
      failIdempotency(idem.key);
      throw err;
    }
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Yorum eklenemedi", 500, "INTERNAL_ERROR");
  }
}
