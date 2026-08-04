import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import * as boardService from "@/services/board.service";
import {
  boardToCsv,
  boardToXlsx,
  dosyaAdiUret,
  type BoardShape,
  type ExportDil,
} from "@/services/export.service";
import { errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// Dosya adi icin proje adi. Erisim kontrolu getBoard icinde yapildigi icin
// bu sorgu YALNIZCA yetki dogrulandiktan sonra cagriliyor.
async function projeAdiGetir(projectId: string): Promise<string> {
  const proje = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  return proje?.name ?? "board";
}

/**
 * Content-Disposition basligi. Turkce karakterli proje adlari icin RFC 5987
 * filename* alani sart; ASCII yedegi eski istemciler icin duruyor.
 */
function indirmeBasligi(ascii: string, utf8: string): string {
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
}

// Board'u disari aktar: ?format=xlsx | csv | json (varsayilan xlsx).
// ?lang=tr | en  -> xlsx basliklarinin dili.
// Yedekleme, raporlama ve gecis islemleri icin - salt okunur.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    // Varsayilan artik xlsx: bu ucun neredeyse tek kullanicisi "panoyu
    // Excel'de acmak isteyen" kisi ve ham CSV o ihtiyaci karsilamiyordu.
    const format = searchParams.get("format") ?? "xlsx";
    const dil: ExportDil = searchParams.get("lang") === "en" ? "en" : "tr";

    if (format !== "xlsx" && format !== "csv" && format !== "json") {
      return errorResponse(
        "Geçersiz format. Desteklenenler: xlsx, csv, json",
        400,
        "VALIDATION_ERROR",
      );
    }

    const board = (await boardService.getBoard(id, user.id)) as unknown as BoardShape;
    const projeAdi = await projeAdiGetir(id);

    if (format === "xlsx") {
      const arabellek = await boardToXlsx(board, projeAdi, dil);
      const { ascii, utf8 } = dosyaAdiUret(projeAdi, "xlsx");
      return new Response(new Uint8Array(arabellek), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": indirmeBasligi(ascii, utf8),
          "Content-Length": String(arabellek.byteLength),
        },
      });
    }

    if (format === "csv") {
      const { ascii, utf8 } = dosyaAdiUret(projeAdi, "csv");
      return new Response(boardToCsv(board), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": indirmeBasligi(ascii, utf8),
        },
      });
    }

    if (format === "json") {
      const { ascii, utf8 } = dosyaAdiUret(projeAdi, "json");
      return new Response(JSON.stringify(board, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": indirmeBasligi(ascii, utf8),
        },
      });
    }

    // format union'i yukarida daraltildi - buraya asla dusmuyoruz.
    return errorResponse("Geçersiz format", 400, "VALIDATION_ERROR");
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Board dışa aktarılamadı");
  }
}
