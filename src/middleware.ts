import { NextRequest, NextResponse } from "next/server";
import { resolveAllowedOrigin } from "./utils/cors";

export function middleware(request: NextRequest) {
  const allowedOrigin = resolveAllowedOrigin(request.headers.get("origin"));

  // Preflight (OPTIONS) — Vercel serverless'ta browser CORS kontrolu
  if (request.method === "OPTIONS") {
    // allowlist disi bir origin: CORS header'i hic eklemeden 204 don -
    // tarayici bunu izin verilmemis olarak yorumlar ve istegi bloklar.
    if (!allowedOrigin) {
      return new NextResponse(null, { status: 204 });
    }
    return new NextResponse(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }

  const response = NextResponse.next();
  if (allowedOrigin) {
    response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
    response.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
