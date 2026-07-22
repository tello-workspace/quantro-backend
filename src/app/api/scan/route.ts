import { NextRequest } from "next/server";
import { runNightlyScan } from "@/services/scan.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { authenticate } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// Gece taramasini elle tetiklemek icin (test + gerekirse manuel calistirma).
export async function POST(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const result = await runNightlyScan();
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Tarama başarısız", 500, "INTERNAL_ERROR");
  }
}
