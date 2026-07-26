import { NextRequest } from "next/server";
import { createChatMessageSchema, listChatMessagesSchema } from "@/schemas/chat.schema";
import * as chatService from "@/services/chat.service";
import { successResponse, errorResponse, validationError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;

    const { searchParams } = new URL(request.url);
    const parsed = listChatMessagesSchema.safeParse({
      before: searchParams.get("before") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) return validationError(parsed.error);

    const messages = await chatService.getMessages(id, parsed.data, user.id);
    return successResponse(messages);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Mesajlar alınamadı", 500, "INTERNAL_ERROR");
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, createChatMessageSchema);
    if (body instanceof Response) return body;

    // Not: burada bilerek idempotency kontrolu yok. Kontrol anahtari
    // userId + path + body hash'i oldugundan, ayni metni ("tamam" gibi)
    // 10 saniye icinde iki kez yazmak duplicate sayilip 409 donerdi.
    // Cift gonderim istemci tarafinda buton kilitlenerek engelleniyor.
    const message = await chatService.createMessage(id, body, user.id);
    return successResponse(message, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Mesaj gönderilemedi", 500, "INTERNAL_ERROR");
  }
}
