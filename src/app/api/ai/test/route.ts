import { NextRequest } from "next/server";
import * as aiService from "@/services/ai.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate } from "@/middleware/auth";
import { AppError } from "@/utils/errors";
import { z } from "zod";

const testAiConfigSchema = z.object({
  provider: z.string().min(1, "Sağlayıcı gerekli"),
  apiKey: z.string().min(1, "API Anahtarı gerekli"),
  baseUrl: z.string().optional().nullable(),
  model: z.string().optional().nullable(),
});

export async function POST(request: NextRequest) {
  const authResponse = await authenticate(request);
  if (authResponse) return authResponse;

  try {
    const rawBody = await request.json();
    const result = testAiConfigSchema.safeParse(rawBody);
    if (!result.success) {
      return errorResponse("Geçersiz test parametreleri", 400, "VALIDATION_ERROR");
    }

    const { provider, apiKey, baseUrl, model } = result.data;
    const testResult = await aiService.testConfiguration({ provider, apiKey, baseUrl, model });

    if (!testResult.success) {
      return errorResponse(testResult.error || "AI testi başarısız oldu", 400, "AI_TEST_FAILED");
    }

    return successResponse({ success: true, message: "AI bağlantı testi başarılı!" });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "AI testi sırasında hata oluştu");
  }
}
