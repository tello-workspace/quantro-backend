import { NextRequest } from "next/server";
import { replyMailSchema } from "@/schemas/mail.schema";
import * as mailService from "@/services/mail.service";
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
    const body = await validateBody(request, replyMailSchema);
    if (body instanceof Response) return body;

    const mail = await mailService.replyToMail(id, body, user.id);
    return successResponse(mail, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Mesaj yanıtlanamadı");
  }
}
