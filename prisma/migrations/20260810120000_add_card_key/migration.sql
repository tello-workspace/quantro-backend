-- İnsan-okunur kart anahtarı: <Project.key>-<Card.number>  ("QNT-42")
--
-- Elle yazıldı çünkü iki geriye dönük doldurma (backfill) adımı var:
-- mevcut projelere anahtar, mevcut kartlara numara üretmek gerekiyor.
-- Prisma'nın ürettiği düz ALTER'lar NOT NULL kolonu boş tabloya ekleyemezdi.

-- ---------- 1) Project.key + Project.cardCounter ----------

ALTER TABLE "Project" ADD COLUMN "key" TEXT;
ALTER TABLE "Project" ADD COLUMN "cardCounter" INTEGER NOT NULL DEFAULT 0;

-- Anahtar üretimi: proje adındaki harflerin ilk 3'ü ("Quantro" -> "QUA").
-- Türkçe/aksanlı ve rakam karakterler düşürülüyor; hiç harf yoksa "PRJ".
-- Aynı organizasyonda aynı köke düşen projeler sıra numarasıyla ayrışıyor
-- (QUA, QUA2, QUA3...). Kök yalnızca harflerden oluştuğu için "QUA2" gibi
-- bir üretilmiş anahtar başka bir projenin köküyle çakışamaz.
WITH taban AS (
  SELECT
    p.id,
    COALESCE(
      NULLIF(UPPER(LEFT(REGEXP_REPLACE(p.name, '[^a-zA-Z]', '', 'g'), 3)), ''),
      'PRJ'
    ) AS kok,
    ROW_NUMBER() OVER (
      PARTITION BY
        p."organizationId",
        COALESCE(
          NULLIF(UPPER(LEFT(REGEXP_REPLACE(p.name, '[^a-zA-Z]', '', 'g'), 3)), ''),
          'PRJ'
        )
      ORDER BY p."createdAt", p.id
    ) AS sira
  FROM "Project" p
)
UPDATE "Project" p
SET "key" = CASE WHEN t.sira = 1 THEN t.kok ELSE t.kok || t.sira::text END
FROM taban t
WHERE p.id = t.id;

ALTER TABLE "Project" ALTER COLUMN "key" SET NOT NULL;

CREATE UNIQUE INDEX "Project_organizationId_key_key" ON "Project"("organizationId", "key");

-- ---------- 2) Card.number ----------

ALTER TABLE "Card" ADD COLUMN "number" INTEGER;

-- Numaralar proje içinde oluşturulma sırasına göre veriliyor: en eski kart
-- 1 numara alıyor. Arşivlenmiş kartlar da numaralanıyor - arşivden dönen bir
-- kartın anahtarsız kalması referansı bozardı.
WITH sirali AS (
  SELECT
    c.id,
    ROW_NUMBER() OVER (
      PARTITION BY col."projectId"
      ORDER BY c."createdAt", c.id
    ) AS sira
  FROM "Card" c
  JOIN "Column" col ON col.id = c."columnId"
)
UPDATE "Card" c
SET "number" = s.sira
FROM sirali s
WHERE c.id = s.id;

-- Sayaç, o projede verilmiş en büyük numaradan devam etsin.
UPDATE "Project" p
SET "cardCounter" = COALESCE((
  SELECT MAX(c."number")
  FROM "Card" c
  JOIN "Column" col ON col.id = c."columnId"
  WHERE col."projectId" = p.id
), 0);

ALTER TABLE "Card" ALTER COLUMN "number" SET NOT NULL;

CREATE INDEX "Card_number_idx" ON "Card"("number");
