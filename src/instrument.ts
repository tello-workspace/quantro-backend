// server.ts'teki ILK import bu olmali - Sentry'nin otomatik enstrumantasyonu
// (http, pg vb.) diger moduller yuklenmeden ONCE devreye girmek zorunda.
// dotenv burada tekrar yukleniyor cunku bu dosya server.ts'in kendi
// "dotenv/config" satirindan once calisiyor olabilir.
import "dotenv/config";
import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
  });
}
