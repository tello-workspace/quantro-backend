import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "@/utils/errors";
import { findCardByKey, formatCardKey, parseCardKey } from "@/services/card-key.service";

interface SearchRow {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  columnId: string;
  columnName: string;
  projectId: string;
  projectName: string;
  /** İnsan-okunur anahtar: "QNT-42" */
  cardKey: string;
}

// Organizasyon panolari buyudukce (cok proje/kart) tek bir panonun
// icinde arama yetmiyor: kullanici "bir yerlerde boyle bir kart olustur
// muştum" dedigi anda hangi projede oldugunu hatirlamak zorunda kaliyordu.
// Bu, org'daki TUM projelerin kartlarinda arar.
//
// unaccent() kullaniliyor: Prisma'nin "insensitive" modu sadece BUYUK/kucuk
// harf farkini kapatiyor, aksan farkini DEGIL. Turkce'de "odeme" yazan biri
// "Ödeme" gecen kartlari da bulabilmeli — bu yuzden duz "contains" yerine
// raw SQL + unaccent() extension'i kullaniliyor.
export async function searchOrganization(organizationId: string, userId: string, query: string) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { userId: true },
  });
  if (!member) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");

  const trimmed = query.trim();
  if (!trimmed) return { cards: [] };

  // "QNT-42" yazıldıysa bu bir arama değil, bir ADRES: tam eşleşen kart
  // varsa tek sonuç olarak dönüyoruz. Metin araması aynı sorguda 0 sonuç
  // verirdi (başlıkta "QNT-42" geçmiyor), oysa kullanıcının kastettiği şey
  // net. Kart bulunamazsa normal metin aramasına düşülüyor.
  const anahtar = parseCardKey(trimmed);
  if (anahtar) {
    const kart = await findCardByKey(organizationId, trimmed);
    if (kart) {
      return {
        cards: [
          {
            id: kart.id,
            title: kart.title,
            description: kart.description,
            priority: kart.priority as string,
            columnId: kart.column.id,
            columnName: kart.column.name,
            projectId: kart.column.project.id,
            projectName: kart.column.project.name,
            cardKey: formatCardKey(kart.column.project.key, kart.number),
          },
        ],
      };
    }
  }

  const pattern = `%${trimmed}%`;

  const rows = await prisma.$queryRaw<SearchRow[]>(Prisma.sql`
    SELECT
      c.id AS "id",
      c.title AS "title",
      c.description AS "description",
      c.priority::text AS "priority",
      col.id AS "columnId",
      col.name AS "columnName",
      p.id AS "projectId",
      p.name AS "projectName",
      p."key" || '-' || c."number" AS "cardKey"
    FROM "Card" c
    JOIN "Column" col ON col.id = c."columnId"
    JOIN "Project" p ON p.id = col."projectId"
    WHERE p."organizationId" = ${organizationId}
      AND (
        unaccent(c.title) ILIKE unaccent(${pattern})
        OR unaccent(COALESCE(c.description, '')) ILIKE unaccent(${pattern})
      )
    ORDER BY c."lastActivityAt" DESC
    LIMIT 25
  `);

  return { cards: rows };
}
