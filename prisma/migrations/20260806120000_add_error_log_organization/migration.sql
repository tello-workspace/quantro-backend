-- AlterTable: ErrorLog org bazli izolasyon icin organizationId kolonu ekler.
-- Mevcut kayitlar hicbir org'a atfedilmez (null) - yeni kapsam geregi bu
-- kayitlar admin listelerinde gorulmez (guvenli varsayilan).
ALTER TABLE "ErrorLog" ADD COLUMN "organizationId" TEXT;
