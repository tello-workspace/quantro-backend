-- Bu migration daha once bu repoda dosya olusturulmadan dogrudan DB'ye
-- uygulanmisti (2026-07-31T07:53:29Z) - _prisma_migrations tablosunda kayitli
-- ama migrations/ klasorunde yoktu. Icerik gercek DB kolonuyla birebir
-- eslesecek sekilde (information_schema uzerinden dogrulanarak) geriye donuk
-- olusturuldu, boylece migration history ile gercek DB semasi arasindaki
-- "drift" ortadan kalkiyor.
ALTER TABLE "User" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'tr';
