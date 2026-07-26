import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/utils/jwt";
import { prisma } from "@/lib/prisma";
import { errorResponse } from "@/utils/api-response";

export type AuthenticatedRequest = NextRequest & {
  user: { id: string; name: string; email: string };
};

type CachedUser = { id: string; name: string; email: string };

// Her istekte kullaniciyi DB'den cekmek uzak veritabaninda ~140ms demek ve
// bu bedel TUM endpoint'lere biniyor. Token zaten imzali oldugu icin buradaki
// sorgunun tek isi "kullanici hala var mi" kontrolu; kisa sureli onbellek
// guvenligi bozmadan bu bedeli kaldiriyor.
//
// TTL kisa tutuldu: silinen/degistirilen kullanici en fazla bu sure kadar
// gecerli kalir. Isim degisikligi de ayni surede yansir.
const USER_CACHE_TTL_MS = 30_000;
const userCache = new Map<string, { user: CachedUser; expiresAt: number }>();

async function getUser(userId: string): Promise<CachedUser | null> {
  const cached = userCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });

  if (user) {
    userCache.set(userId, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  } else {
    userCache.delete(userId);
  }
  return user;
}

// Kullanici silindiginde/guncellendiginde onbellegi hemen dusurmek icin
export function invalidateUserCache(userId: string) {
  userCache.delete(userId);
}

export async function authenticate(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Token gerekli", 401, "UNAUTHORIZED");
    }

    const token = authHeader.slice(7);
    const payload = verifyToken(token);

    const user = await getUser(payload.userId);

    if (!user) {
      return errorResponse("Kullanıcı bulunamadı", 401, "UNAUTHORIZED");
    }

    (request as AuthenticatedRequest).user = user;
  } catch {
    return errorResponse("Token süresi dolmuş veya geçersiz", 401, "TOKEN_EXPIRED");
  }
}
