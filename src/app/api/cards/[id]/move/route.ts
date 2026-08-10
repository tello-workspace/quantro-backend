import { NextRequest } from "next/server";
import { moveCardToProjectSchema } from "@/schemas/card.schema";
import * as cardService from "@/services/card.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// Karti BASKA BIR PROJENIN kolonuna tasir. PATCH /api/cards/[id]'nin
// columnId alanindan bilerek ayri: hedef proje degisince etiket/ozel alan
// gibi proje-bazli verinin dusmesi gerekebilir, bu davranis genel PATCH
// ucunun (otomasyon/AI/toplu islem de kullaniyor) beklemedigi bir seydir.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, moveCardToProjectSchema);
    if (body instanceof Response) return body;

    const result = await cardService.moveCardToProject(id, body.targetColumnId, user.id);
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Kart taşınamadı");
  }
}
