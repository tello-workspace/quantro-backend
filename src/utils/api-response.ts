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
async function resolveOrganizationIdFromPath(
  pathname: string,
  userId?: string,
): Promise<string | null> {
  const segments = pathname.split("/").filter(Boolean); // ["api", "organizations", "<id>", ...]

  // Yoldan cikan org id yalnizca bir ADAYDIR; asagida uyelik dogrulamasindan
  // gecmeden hicbir kayda yazilmaz (bkz. fonksiyon sonundaki kontrol).
  let adayOrganizationId: string | null = null;

  // /api/organizations/<id>... → id dogrudan org id'sidir.
  const orgIndex = segments.indexOf("organizations");
  if (orgIndex !== -1 && segments[orgIndex + 1]) {
    adayOrganizationId = segments[orgIndex + 1];
  }

  // Buradan asagisi DB'ye dokunuyor ve bu fonksiyon zaten bir 500 islenirken
  // cagriliyor: hatanin sebebi DB'nin kendisi ise (ornegin pooler dolmussa)
  // asagidaki sorgu da reddedilir. Bu ikinci hata disari sizarsa yakalanmamis
  // bir promise reddine, o da Node'un sureci komple dusurmesine yol acar.
  // Org atfi yalnizca yardimci bir bilgi oldugu icin hatayi yutup null donuyoruz.
  try {
    // /api/projects/<id>... → projenin org'sunu bul.
    const projectIndex = segments.indexOf("projects");
    if (adayOrganizationId === null && projectIndex !== -1 && segments[projectIndex + 1]) {
      const project = await prisma.project.findUnique({
        where: { id: segments[projectIndex + 1] },
        select: { organizationId: true },
      });
      adayOrganizationId = project?.organizationId ?? null;
    }

    // /api/cards/<id>... → kart → kolon → proje → org zincirini takip et.
    const cardIndex = segments.indexOf("cards");
    if (adayOrganizationId === null && cardIndex !== -1 && segments[cardIndex + 1]) {
      const card = await prisma.card.findUnique({
        where: { id: segments[cardIndex + 1] },
        select: { column: { select: { project: { select: { organizationId: true } } } } },
      });
      adayOrganizationId = card?.column?.project?.organizationId ?? null;
    }

    if (adayOrganizationId === null) {
      return null;
    }

    // GUVENLIK: aday org id yoldan geliyor ve yol saldirganin kontrolunde.
    // Dogrulanmadan yazilirsa herhangi bir gecerli oturum, yabanci bir org'un
    // id'sini yola koyup (ornegin bozuk JSON ile erisim kontrolunden once 500
    // tetikleyerek) o org'un admin panelindeki hata listesine kayit enjekte
    // edebiliyordu. Kaydi ancak istegi yapan kullanici gercekten o org'un
    // uyesiyse org'a atfediyoruz; kullanici yoksa ya da uye degilse null
    // donuyoruz - kayit yine tutulur, sadece hicbir org admininin listesine
    // dusmez (guvenli varsayilan).
    if (!userId) {
      return null;
    }

    const uyelik = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: adayOrganizationId, userId } },
      select: { organizationId: true },
    });
    return uyelik ? adayOrganizationId : null;
  } catch (cozumlemeHatasi) {
    console.error("[api-response] Hata kaydinin organizasyonu cozulemedi:", cozumlemeHatasi);
    return null;
  }
}

// catch bloklarindaki tekrar eden "AppError degilse genel 500 don" kalibinin
// yerini alir: hatayi hem konsola hem ErrorLog tablosuna yazar (fire-and-forget,
// loglama hicbir zaman route'un cevap suresini uzatmaz veya cevabi bozmaz).
export function handleApiError(request: NextRequest, error: unknown, fallbackMessage: string) {
  const userId = (request as unknown as { user?: { id: string } }).user?.id;

  // Bekletilmeyen (fire-and-forget) IIFE: .catch olmadan icerideki herhangi bir
  // reddetme yakalanmamis promise reddine donusur ve Node 15+ varsayilaninda
  // surec sonlanir - yani tek bir loglama hatasi tum Socket.IO baglantilarini
  // birlikte dusurur. Son care olarak burada yutuyoruz; loglama hicbir kosulda
  // sunucuyu dusurmemeli.
  void (async () => {
    // userId'yi de veriyoruz: org atfi ancak kullanicinin o org'a uyeligi
    // dogrulandiktan sonra yapiliyor (yabanci org'a kayit enjeksiyonunu onler).
    const organizationId = await resolveOrganizationIdFromPath(request.nextUrl.pathname, userId);
    await logError({
      error,
      method: request.method,
      path: request.nextUrl.pathname,
      userId,
      organizationId: organizationId ?? undefined,
    });
  })().catch((loglamaHatasi) => {
    console.error("[api-response] Hata kaydi yazilamadi:", loglamaHatasi);
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
