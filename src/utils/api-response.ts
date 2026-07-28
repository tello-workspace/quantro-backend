import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { logError } from "@/utils/logger";

// Başarılı response
type SuccessPayload<T = unknown> = {
  success: true;
  data: T;
};

// Hata response
type ErrorPayload = {
  success: false;
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
};

export function successResponse<T>(data: T, status = 200) {
  const body: SuccessPayload<T> = { success: true, data };
  return NextResponse.json(body, { status });
}

export function errorResponse(
  message: string,
  status = 400,
  code = "INTERNAL_ERROR",
) {
  const body: ErrorPayload = {
    success: false,
    error: { code, message },
  };
  return NextResponse.json(body, { status });
}

// catch bloklarindaki tekrar eden "AppError degilse genel 500 don" kalibinin
// yerini alir: hatayi hem konsola hem ErrorLog tablosuna yazar (fire-and-forget,
// loglama hicbir zaman route'un cevap suresini uzatmaz veya cevabi bozmaz).
export function handleApiError(request: NextRequest, error: unknown, fallbackMessage: string) {
  const userId = (request as unknown as { user?: { id: string } }).user?.id;

  void logError({
    error,
    method: request.method,
    path: request.nextUrl.pathname,
    userId,
  });

  return errorResponse(fallbackMessage, 500, "INTERNAL_ERROR");
}

export function validationError(zodError: ZodError) {
  const fields: Record<string, string> = {};
  for (const issue of zodError.issues) {
    const path = issue.path.join(".");
    if (!fields[path]) {
      fields[path] = issue.message;
    }
  }

  const body: ErrorPayload = {
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      message: "Geçersiz veri",
      fields,
    },
  };
  return NextResponse.json(body, { status: 400 });
}
