import { NextRequest, NextResponse } from "next/server";
import { resolveAllowedOrigin } from "./utils/cors";
import { checkGlobalRateLimit, hasOwnRateLimit } from "./middleware/rateLimit";

// Bu dosya eskiden src/middleware.ts idi. Next.js 16'da `middleware`
// convention'i DEPRECATED olup `proxy` olarak yeniden adlandirildi
// (node_modules/next/dist/docs/.../file-conventions/middleware.md). Islevsel
// olarak ayni; export adi `middleware` -> `proxy` degisti.
//
// Isim degisikliginin burada ayrica onemi var: proxy VARSAYILAN OLARAK
// Node.js runtime'inda calisiyor ve `runtime` secenegi kabul etmiyor. Asagida
// jsonwebtoken ile imza dogrulamasi yapabilmemizin sebebi bu - Edge runtime'da
// o paket calismazdi.

// Ortak CORS basliklari. Hem normal akista hem de 429 yanitinda uygulanmak
// zorunda: basliksiz donen bir 429'u tarayici CORS hatasi olarak yorumlar ve
// istemci "cok fazla istek" mesajini HIC goremez, yerine anlamsiz bir ag
// hatasi gorur.
function applyCors(response: NextResponse, allowedOrigin: string | null) {
  if (!allowedOrigin) return response;
  response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.headers.set("Access-Control-Allow-Credentials", "true");
  return response;
}

export function proxy(request: NextRequest) {
  const allowedOrigin = resolveAllowedOrigin(request.headers.get("origin"));

  // Preflight (OPTIONS) — tarayici CORS kontrolu.
  // Preflight SAYILMIYOR: her gercek istekten once bir tane geldigi icin
  // saymak kullanicinin butcesini iki katina cikarirdi. Ustelik preflight
  // Authorization basligi tasimaz, yani hepsi IP kovasina duserdi.
  if (request.method === "OPTIONS") {
    // Allowlist disi origin: CORS basligi hic eklemeden 204 don - tarayici
    // bunu izin verilmemis olarak yorumlar ve istegi bloklar.
    if (!allowedOrigin) {
      return new NextResponse(null, { status: 204 });
    }
    return applyCors(new NextResponse(null, { status: 204 }), allowedOrigin);
  }

  // Genel taban limit. auth/* ve ai/* kendi (daha dar) kovalarini
  // kullaniyor, onlari burada tekrar saymiyoruz.
  if (!hasOwnRateLimit(request.nextUrl.pathname)) {
    const rateLimited = checkGlobalRateLimit(request);
    if (rateLimited) {
      return applyCors(rateLimited as NextResponse, allowedOrigin);
    }
  }

  return applyCors(NextResponse.next(), allowedOrigin);
}

export const config = {
  matcher: "/api/:path*",
};
