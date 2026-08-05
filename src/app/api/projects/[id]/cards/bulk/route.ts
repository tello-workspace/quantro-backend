import { NextRequest } from "next/server";
import { z } from "zod";
import * as bulkCardService from "@/services/bulk-card.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// Tek seferde islenebilecek kart sayisi. Ust sinir yoksa tek istek yuzlerce
// kartlik bir dongu baslatip istegi zaman asimina ugratabilir.
const MAX_CARDS = 100;

const bulkSchema = z
  .object({
    cardIds: z.array(z.string()).min(1, "En az bir kart seçilmeli").max(MAX_CARDS),
    action: z.enum(["move", "assign", "label", "archive", "delete", "watch", "unwatch"]),
    columnId: z.string().optional(),
    assigneeIds: z.array(z.string()).optional(),
    labelId: z.string().optional(),
    positions: z.record(z.string(), z.number()).optional(),
  })
  .refine((d) => d.action !== "move" || !!d.columnId, {
    message: "Taşıma için hedef sütun gerekli",
    path: ["columnId"],
  })
  .refine((d) => d.action !== "label" || !!d.labelId, {
    message: "Etiket için labelId gerekli",
    path: ["labelId"],
  })
  .refine((d) => d.action !== "assign" || Array.isArray(d.assigneeIds), {
    message: "Atama için assigneeIds gerekli",
    path: ["assigneeIds"],
  });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id: projectId } = await params;

    const body = await request.json().catch(() => null);
    const parsed = bulkSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        parsed.error.issues[0]?.message || "Geçersiz istek",
        400,
        "VALIDATION_ERROR",
      );
    }

    const result = await bulkCardService.bulkCardAction(projectId, parsed.data, user.id);
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Toplu işlem uygulanamadı");
  }
}
