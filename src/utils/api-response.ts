import { NextResponse } from "next/server";
import { ZodError } from "zod";

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
