const DEFAULT_DEV_ORIGINS = ["http://localhost:3000", "http://localhost:3001"];

function getAllowedOrigins(): string[] {
  const configured = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(",").map((origin) => origin.trim()).filter(Boolean)
    : [];
  return [...configured, ...DEFAULT_DEV_ORIGINS];
}

// Origin yoksa (direct curl/postman, ayni-origin istek) varsayilani doner.
// Origin varsa SADECE allowlist'teki (FRONTEND_URL + localhost) bir origin ise
// aynen yansitilir; degilse null doner ve cagiran taraf CORS header'ini hic
// eklemez - boylece tarayici istegi bloklar. Onceden buradaki kontrol atlanip
// gelen origin ne olursa olsun dogrudan yansitiliyordu; Allow-Credentials:true
// ile birlesince herhangi bir sitenin (JWT'yi cookie'de tutan bir gelecek
// degisiklikte) credentialed istek atabilmesine izin veren bir CORS acigiydi.
export function resolveAllowedOrigin(requestOrigin: string | null): string | null {
  const allowed = getAllowedOrigins();

  if (!requestOrigin) {
    return allowed[0] ?? null;
  }

  return allowed.includes(requestOrigin) ? requestOrigin : null;
}
