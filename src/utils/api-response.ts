import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { logError } from "@/utils/logger";
import { prisma } from "@/lib/prisma";

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

// Hatanin hangi organizasyonda olustugunu path'ten cozer. 500 hatalari nadir
// oldugu icin tek bir ek sorgu kabul edilebilir; cogu route'ta istemcinin
// organizasyonu path'teki bir id ile gelir. Cozulemeyen durumlarda null doner
// ve kayit hicbir org'a atfedilmez (dolayisiyla hicbir admin tarafindan
// gorulemez - guvenli varsayilan).
//
// Org bazli izolasyon: global admin yok; adminler yalnizca kendi org'larinin
// hata kayitlarini gorebilsin (bkz. error-log.service). Bu cozum, kaydi org'a
// baglar ki filtre yapilabilsin.
async function resolveOrganizationIdFromPath(pathname: string): Promise<string | null> {
  const segments = pathname.split("/").filter(Boolean); // ["api", "organizations", "<id>", ...]

  // /api/organizations/<id>... → id dogrudan org id'sidir.
  const orgIndex = segments.indexOf("organizations");
  if (orgIndex !== -1 && segments[orgIndex + 1]) {
    return segments[orgIndex + 1];
  }

  // /api/projects/<id>... → projenin org'sunu bul.
  const projectIndex = segments.indexOf("projects");
  if (projectIndex !== -1 && segments[projectIndex + 1]) {
    const project = await prisma.project.findUnique({
      where: { id: segments[projectIndex + 1] },
      select: { organizationId: true },
    });
    return project?.organizationId ?? null;
  }

  // /api/cards/<id>... → kart → kolon → proje → org zincirini takip et.
  const cardIndex = segments.indexOf("cards");
  if (cardIndex !== -1 && segments[cardIndex + 1]) {
    const card = await prisma.card.findUnique({
      where: { id: segments[cardIndex + 1] },
      select: { column: { select: { project: { select: { organizationId: true } } } } },
    });
    return card?.column?.project?.organizationId ?? null;
  }

  return null;
}

// catch bloklarindaki tekrar eden "AppError degilse genel 500 don" kalibinin
// yerini alir: hatayi hem konsola hem ErrorLog tablosuna yazar (fire-and-forget,
// loglama hicbir zaman route'un cevap suresini uzatmaz veya cevabi bozmaz).
export function handleApiError(request: NextRequest, error: unknown, fallbackMessage: string) {
  const userId = (request as unknown as { user?: { id: string } }).user?.id;

  void (async () => {
    const organizationId = await resolveOrganizationIdFromPath(request.nextUrl.pathname);
    await logError({
      error,
      method: request.method,
      path: request.nextUrl.pathname,
      userId,
      organizationId: organizationId ?? undefined,
    });
  })();

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
