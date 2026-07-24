import { NextRequest } from "next/server";
import { createCardSchema, updateCardSchema } from "@/schemas/card.schema";
import * as cardService from "@/services/card.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { checkIdempotency, clearIdempotency, failIdempotency } from "@/middleware/idempotency";
import { AppError } from "@/utils/errors";

// POST /api/projects/{id}/tasks — sadece title + columnId alır, kart oluşturur
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const body = await request.json();
    const { columnId, title, description, priority, assigneeIds, dueDate } = body;
    if (!columnId || !title) {
      return errorResponse("columnId ve title zorunludur", 400, "VALIDATION_ERROR");
    }

    // Idempotency check
    const idem = checkIdempotency(request, user.id, body);
    if (idem instanceof Response) return idem;

    try {
      const card = await cardService.createCard(columnId, {
        title,
        description: description || undefined,
        priority: priority || "MEDIUM",
        assigneeIds: Array.isArray(assigneeIds) ? assigneeIds : undefined,
        dueDate: dueDate || undefined,
      }, user.id);

      clearIdempotency(idem.key);
      return successResponse({
        id: card.id,
        title: card.title,
        description: card.description,
        dueDate: card.dueDate?.toISOString().split("T")[0],
        columnId: card.columnId,
        assignees: card.assignees.map((a) => ({ id: a.user.id, name: a.user.name })),
      }, 201);
    } catch (err) {
      failIdempotency(idem.key);
      throw err;
    }
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Kart oluşturulamadı", 500, "INTERNAL_ERROR");
  }
}
