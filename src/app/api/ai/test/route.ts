import { NextRequest } from "next/server";
import * as aiService from "@/services/ai.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { checkAiRateLimit } from "@/middleware/rateLimit";
import { guvenliWebhookUrlDogrula, WebhookGuvenlikHatasi } from "@/utils/webhook-security";
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
    const user = (request as AuthenticatedRequest).user;

    // Bu uç, diğer tüm AI uçlarının aksine hiç hız sınırından geçmiyordu:
    // kimliği doğrulanmış herhangi bir kullanıcı sunucudan dışarıya sınırsız
    // sayıda istek tetikleyebiliyor, aşağıdaki URL doğrulaması olsa bile
    // deneme sayısı sınırsız kalıyordu.
    const rateLimitError = checkAiRateLimit(user.id, "ai:test");
    if (rateLimitError) return rateLimitError;

    const rawBody = await request.json();
    const result = testAiConfigSchema.safeParse(rawBody);
    if (!result.success) {
      return errorResponse("Geçersiz test parametreleri", 400, "VALIDATION_ERROR");
    }

    const { provider, apiKey, baseUrl, model } = result.data;

    // GÜVENLİK (SSRF): baseUrl hiçbir doğrulamadan geçmeden doğrudan
    // fetch(`${baseUrl}/chat/completions`) içine gidiyordu. Aynı alan profile
    // kaydedilirken (auth.service: assertGuvenliAiBaseUrl) ve kullanım anında
    // (ai.service: getProvider) doğrulanırken bu uç kontrolü atlıyordu; yani
    // kullanıcı http://169.254.169.254 gibi bir iç adres verip sunucuyu kendi
    // iç ağına/bulut metadata servisine istek atmaya zorlayabiliyordu.
    if (baseUrl) {
      try {
        await guvenliWebhookUrlDogrula(baseUrl);
      } catch (err) {
        if (err instanceof WebhookGuvenlikHatasi) {
          return errorResponse(`Geçersiz AI taban URL'i: ${err.message}`, 400, "VALIDATION_ERROR");
        }
        throw err;
      }
    }

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
