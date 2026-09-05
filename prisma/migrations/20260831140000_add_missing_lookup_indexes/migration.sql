-- Eksik arama indeksleri.
--
-- Uc sorgu yolu da tam tablo tariyordu:
--   1. Column.projectId  -> pano her acilista kolonlari projeye gore cekiyor
--      (board.service.getBoard). Column'da hic index yoktu.
--   2. CardAssignee.userId -> bilesik birincil anahtar (cardId, userId) cardId
--      ile basladigi icin KULLANICIDAN baslayan sorgular ("bana atanan
--      kartlar", gunluk ozet) onu kullanamiyordu.
--   3. CardDependency.blockedId -> anahtar blockerId ile basliyor; "bu karti
--      kim blokluyor" sorgusu (requireNoOpenBlockers kolon gecis kurali ve
--      kart detayi) ters yonden geliyor.
--
-- IF NOT EXISTS: indeksler elle acilmis olabilir; migration'in yeniden
-- calistirilmasi hata vermesin.

CREATE INDEX IF NOT EXISTS "Column_projectId_idx" ON "Column"("projectId");

CREATE INDEX IF NOT EXISTS "CardAssignee_userId_idx" ON "CardAssignee"("userId");

CREATE INDEX IF NOT EXISTS "CardDependency_blockedId_idx" ON "CardDependency"("blockedId");
