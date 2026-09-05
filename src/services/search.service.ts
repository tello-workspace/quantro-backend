import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "@/utils/errors";
import { findCardByKey, formatCardKey, parseCardKey } from "@/services/card-key.service";
import { getVisibleProjectIds } from "@/services/access-control.service";

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
  // GUEST'ler ve TEAM/PRIVATE gorunurluklu projeler icin acikca eklenmemis
  // uyeler o projenin kartlarini aramada da gormemeli - aksi halde board'da
  // gizlenen bir proje, arama uzerinden baypas edilmis olurdu. Bos donen
  // Set uyeligin kendisi gecersiz demektir.
  const visibleProjectIds = await getVisibleProjectIds(organizationId, userId);
  if (visibleProjectIds.size === 0) {
    const isMember = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { userId: true },
    });
    if (!isMember) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");
    return { cards: [] };
  }

  const trimmed = query.trim();
  if (!trimmed) return { cards: [] };

  // "QNT-42" yazıldıysa bu bir arama değil, bir ADRES: tam eşleşen kart
  // varsa tek sonuç olarak dönüyoruz. Metin araması aynı sorguda 0 sonuç
  // verirdi (başlıkta "QNT-42" geçmiyor), oysa kullanıcının kastettiği şey
  // net. Kart bulunamazsa (ya da erişilemeyen bir projedeyse) normal metin
  // aramasına düşülüyor.
  const anahtar = parseCardKey(trimmed);
  if (anahtar) {
    const kart = await findCardByKey(organizationId, trimmed);
    // Arsivlenmis kart elenir: board/dashboard/roadmap/insight hepsi
    // isArchived=false suzuyor, arama tek istisna olmamali. Anahtarla gelen
    // arsivli kart sonuc olarak donmez, asagidaki metin aramasina duser.
    if (kart && !kart.isArchived && visibleProjectIds.has(kart.column.project.id)) {
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

  // ILIKE joker karakterleri kacirilir: parametre baglamasi SQL enjeksiyonunu
  // engelliyor ama "%" ve "_" hala DESEN olarak yorumlaniyordu. Kacirilmadan
  // "__" arayan kullanici `%__%` deseniyle org'daki tum kartlari dokerdi.
  // Ters bolu de kacirilmali, yoksa kendisi kacis karakteri sayilir.
  const kacirilmis = trimmed.replace(/[\\%_]/g, "\\$&");
  const pattern = `%${kacirilmis}%`;

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
      AND p.id IN (${Prisma.join([...visibleProjectIds])})
      AND c."isArchived" = false
      AND (
        unaccent(c.title) ILIKE unaccent(${pattern}) ESCAPE '\\'
        OR unaccent(COALESCE(c.description, '')) ILIKE unaccent(${pattern}) ESCAPE '\\'
      )
    ORDER BY c."lastActivityAt" DESC
    LIMIT 25
  `);

  return { cards: rows };
}
