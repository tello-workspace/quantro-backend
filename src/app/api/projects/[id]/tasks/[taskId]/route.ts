import { NextRequest } from "next/server";
import { updateCardSchema } from "@/schemas/card.schema";
import * as cardService from "@/services/card.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// GET /api/projects/{projectId}/tasks/{taskId} — kart detayı
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { taskId } = await params;
    const card = await cardService.getCardById(taskId, user.id);

    return successResponse({
      id: card.id,
      title: card.title,
      description: card.description,
      dueDate: card.dueDate?.toISOString().split("T")[0],
      columnId: card.columnId,
      assignees: card.assignees.map((a) => ({ id: a.user.id, name: a.user.name })),
    });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Kart alınamadı", 500, "INTERNAL_ERROR");
  }
}

// PUT /api/projects/{projectId}/tasks/{taskId} — kart güncelleme
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { taskId } = await params;
    const body = await request.json();
    const { title, description, dueDate, assigneeIds, columnId } = body;

    // Sadece backend'in bildiği alanları geç
    const updateData: Record<string, unknown> = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (dueDate !== undefined) updateData.dueDate = dueDate ? new Date(dueDate).toISOString() : null;
    if (columnId !== undefined) updateData.columnId = columnId;
    if (assigneeIds !== undefined) updateData.assigneeIds = Array.isArray(assigneeIds) ? assigneeIds : [];

    const validated = updateCardSchema.parse(updateData);
    const card = await cardService.updateCard(taskId, validated, user.id);

    return successResponse({
      id: card.id,
      title: card.title,
      description: card.description,
      dueDate: card.dueDate?.toISOString().split("T")[0],
      columnId: card.columnId,
      assignees: card.assignees.map((a) => ({ id: a.user.id, name: a.user.name })),
    });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Kart güncellenemedi", 500, "INTERNAL_ERROR");
  }
}

// DELETE /api/projects/{projectId}/tasks/{taskId} — kart silme
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { taskId } = await params;
    await cardService.deleteCard(taskId, user.id);
    return successResponse({ deleted: true });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Kart silinemedi", 500, "INTERNAL_ERROR");
  }
}
