const DEFAULT_DEV_ORIGINS = ["http://localhost:3000", "http://localhost:3001"];

function getAllowedOrigins(): string[] {
  const configured = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(",").map((origin) => origin.trim()).filter(Boolean)
    : [];
  return [...configured, ...DEFAULT_DEV_ORIGINS];
}

export function resolveAllowedOrigin(requestOrigin: string | null): string {
  const allowed = getAllowedOrigins();
  if (requestOrigin && allowed.includes(requestOrigin)) {
    return requestOrigin;
  }
  return allowed[0];
}
