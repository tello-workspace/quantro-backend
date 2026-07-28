-- Turkce aksanli karakterler (o/ö, i/ı/İ, u/ü, s/ş, c/ç, g/ğ) icin
-- aksan-duyarsiz arama. Ornek: kullanici "odeme" yazinca "Ödeme" iceren
-- kartlari da bulabilsin (case-insensitive ILIKE bunu TEK BASINA cozmuyor,
-- aksan farkli bir harf sayiliyor).
CREATE EXTENSION IF NOT EXISTS unaccent;
