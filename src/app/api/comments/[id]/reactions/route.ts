import { NextRequest } from "next/server";
import { toggleReactionSchema } from "@/schemas/comment.schema";
import * as commentService from "@/services/comment.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// Toggle: ayni emoji ile ikinci istek reaksiyonu kaldirir.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, toggleReactionSchema);
    if (body instanceof Response) return body;

    const reactions = await commentService.toggleReaction(id, user.id, body.emoji);
    return successResponse(reactions);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Reaksiyon eklenemedi");
  }
}
