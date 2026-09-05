import { NextRequest } from "next/server";
import { createGithubLinkSchema, updateGithubLinkSchema } from "@/schemas/github.schema";
import * as githubLinkService from "@/services/github-link.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// Proje basina TEK baglanti oldugu icin koleksiyon degil tekil kaynak:
// GET/POST/PATCH/DELETE hepsi ayni adreste calisiyor.

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    // Baglanti yoksa null doner - istemci "henuz kurulmamis" durumunu
    // 404'u hata gibi ele almak zorunda kalmadan gosterebiliyor.
    return successResponse(await githubLinkService.getLink(id, user.id));
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error.message, error.statusCode, error.code);
    return handleApiError(request, error, "GitHub bağlantısı alınamadı");
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, createGithubLinkSchema);
    if (body instanceof Response) return body;

    // Yanit secret'i ICERIYOR - yalnizca bu bir kez.
    return successResponse(await githubLinkService.createLink(id, body, user.id), 201);
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error.message, error.statusCode, error.code);
    return handleApiError(request, error, "GitHub bağlantısı kurulamadı");
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, updateGithubLinkSchema);
    if (body instanceof Response) return body;

    return successResponse(await githubLinkService.updateLink(id, body, user.id));
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error.message, error.statusCode, error.code);
    return handleApiError(request, error, "GitHub bağlantısı güncellenemedi");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    await githubLinkService.deleteLink(id, user.id);
    return successResponse({ silindi: true });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error.message, error.statusCode, error.code);
    return handleApiError(request, error, "GitHub bağlantısı silinemedi");
  }
}
