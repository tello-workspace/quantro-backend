-- Kart izleme (watcher) ozelligi urunden kaldirildi: kullanici kullanissiz
-- buldu. Tablo dusuruluyor. NotificationType icindeki WATCHED_CARD_ACTIVITY
-- degeri bilerek birakildi - Postgres'te enum degeri silmek tipi bastan
-- yaratmayi gerektiriyor ve kullanilmayan deger zarar vermiyor.
DROP TABLE IF EXISTS "CardWatcher";
