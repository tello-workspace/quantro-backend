const DEFAULT_DEV_ORIGINS = ["http://localhost:3000", "http://localhost:3001"];

function getAllowedOrigins(): string[] {
  const configured = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(",").map((origin) => origin.trim()).filter(Boolean)
    : [];
  return [...configured, ...DEFAULT_DEV_ORIGINS];
}

export function resolveAllowedOrigin(requestOrigin: string | null): string {
  // Gelen origin varsa direkt onu yansıt — JWT koruması var, CSRF riski yok
  if (requestOrigin) return requestOrigin;

  // Origin yoksa (direct curl/postman) varsayılanı ver
  if (process.env.FRONTEND_URL) {
    return getAllowedOrigins()[0];
  }
  return DEFAULT_DEV_ORIGINS[0];
}
