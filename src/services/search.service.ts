import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "@/utils/errors";

interface SearchRow {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  columnId: string;
  columnName: string;
  projectId: string;
  projectName: string;
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
      p.name AS "projectName"
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
