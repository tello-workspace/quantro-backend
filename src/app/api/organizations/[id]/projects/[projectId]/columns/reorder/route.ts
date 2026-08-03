import { NextRequest } from "next/server";
import * as columnService from "@/services/column.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";
import { z } from "zod";

const reorderSchema = z.object({
  columnIds: z.array(z.string()).min(1, "En az bir sütun ID'si gerekli"),
});

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; projectId: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { projectId } = await params;
    const body = await request.json();
    const parsed = reorderSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error.errors[0]?.message || "Geçersiz istek", 400);
    }

    const columns = await columnService.reorderColumns(projectId, parsed.data.columnIds, user.id);
    return successResponse(columns);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Sütunlar yeniden sıralanamadı");
  }
}
