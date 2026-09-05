import { prisma } from "@/lib/prisma";
import { ForbiddenError, ValidationError } from "@/utils/errors";
import { checkProjectAccess } from "@/services/access-control.service";
import { parseCsv } from "@/utils/csv-parse";
import type { ColumnMappingEntry } from "@/schemas/import.schema";
import type { Priority, Prisma } from "@prisma/client";

// Bu servis KASITLI OLARAK bulk-card.service.ts'teki dersi izliyor: bir
// icera aktarim yuzlerce kart yaratabilir, kart basina tek tek create()
// cagirmak (numara ayirma + yazma + iliskiler) N*birkac sorgu demek olur ve
// paylasilan pooler'i tuketir. Bunun yerine HER ASAMA kume bazli: numaralar
// TEK bir sayac artisiyla topluca ayrilir, kartlar TEK createMany ile yazilir,
// id'ler TEK findMany ile numaradan geri okunur, etiket/checklist/atama
// baglantilari TEK'er createMany ile eklenir. Toplam sorgu sayisi kart
// sayisindan BAGIMSIZ (~10 civari).

export type ImportFormat = "TRELLO_JSON" | "JIRA_CSV";

interface ParsedCard {
  sourceColumnId: string;
  title: string;
  description?: string;
  labels: string[];
  assigneeIdentifiers: string[];
  checklistItems: { text: string; done: boolean }[];
  priority?: Priority;
}

interface ParsedColumn {
  sourceId: string;
  name: string;
}

interface ParsedImport {
  columns: ParsedColumn[];
  cards: ParsedCard[];
}

// ------------------------------------------------------------ dosya ayristirma

function ayristirTrelloJson(icerik: string): ParsedImport {
  let veri: any;
  try {
    veri = JSON.parse(icerik);
  } catch {
    throw new ValidationError("Geçersiz Trello JSON dosyası");
  }
  if (!Array.isArray(veri?.lists) || !Array.isArray(veri?.cards)) {
    throw new ValidationError("Bu bir Trello pano dışa aktarımına benzemiyor (lists/cards alanı yok)");
  }

  const listeAdlari = new Map<string, string>(veri.lists.map((l: any) => [l.id, String(l.name ?? "")]));
  const uyeAdlari = new Map<string, string>(
    (veri.members ?? []).map((m: any) => [m.id, String(m.fullName || m.username || "")]),
  );
  const etiketAdlari = new Map<string, { name: string; color: string | null }>(
    (veri.labels ?? []).map((l: any) => [l.id, { name: String(l.name ?? ""), color: l.color ?? null }]),
  );

  // checklists Trello export'unda ayri bir ust-seviye dizi - karta idCard ile bagli.
  const checklistlerByCard = new Map<string, any[]>();
  for (const cl of veri.checklists ?? []) {
    const liste = checklistlerByCard.get(cl.idCard) ?? [];
    liste.push(cl);
    checklistlerByCard.set(cl.idCard, liste);
  }

  const cards: ParsedCard[] = [];
  for (const kart of veri.cards) {
    // Arsivlenmis (closed) kartlar goc kapsami disi - taze bir pano
    // istiyoruz, Trello'nun eski cop kutusu degil.
    if (kart.closed) continue;
    if (!listeAdlari.has(kart.idList)) continue;

    const etiketler: string[] = Array.isArray(kart.labels) && kart.labels.length > 0
      ? kart.labels.map((l: any) => String(l.name ?? "")).filter(Boolean)
      : (kart.idLabels ?? []).map((id: string) => etiketAdlari.get(id)?.name).filter(Boolean);

    const atananlar: string[] = (kart.idMembers ?? [])
      .map((id: string) => uyeAdlari.get(id))
      .filter((ad: string | undefined): ad is string => !!ad);

    const kartinChecklistleri = checklistlerByCard.get(kart.id) ?? [];
    const birdenFazlaChecklist = kartinChecklistleri.length > 1;
    const checklistItems = kartinChecklistleri.flatMap((cl: any) =>
      (cl.checkItems ?? []).map((item: any) => ({
        text: birdenFazlaChecklist ? `[${cl.name}] ${item.name}` : String(item.name ?? ""),
        done: item.state === "complete",
      })),
    );

    cards.push({
      sourceColumnId: kart.idList,
      title: String(kart.name ?? "(başlıksız)").slice(0, 500),
      description: kart.desc || undefined,
      labels: etiketler,
      assigneeIdentifiers: atananlar,
      checklistItems,
    });
  }

  const kartSayisi = new Map<string, number>();
  for (const k of cards) kartSayisi.set(k.sourceColumnId, (kartSayisi.get(k.sourceColumnId) ?? 0) + 1);

  const columns: ParsedColumn[] = veri.lists
    .filter((l: any) => kartSayisi.has(l.id))
    .map((l: any) => ({ sourceId: l.id, name: String(l.name ?? "") }));

  return { columns, cards };
}

const JIRA_ONCELIK_ESLESMESI: Record<string, Priority> = {
  lowest: "LOW",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  highest: "URGENT",
  urgent: "URGENT",
  critical: "URGENT",
};

function baslikIndeksleriniBul(baslik: string[]) {
  const normalize = (s: string) => s.trim().toLowerCase();
  const bul = (...adaylar: string[]) => {
    for (const aday of adaylar) {
      const idx = baslik.findIndex((h) => normalize(h) === aday);
      if (idx !== -1) return idx;
    }
    return -1;
  };
  return {
    key: bul("issue key", "key"),
    summary: bul("summary"),
    status: bul("status"),
    assignee: bul("assignee"),
    priority: bul("priority"),
    labels: bul("labels"),
    description: bul("description"),
  };
}

function ayristirJiraCsv(icerik: string): ParsedImport {
  const satirlar = parseCsv(icerik);
  if (satirlar.length < 2) {
    throw new ValidationError("CSV dosyasında başlık dışında satır bulunamadı");
  }

  const [baslik, ...veriSatirlari] = satirlar;
  const idx = baslikIndeksleriniBul(baslik);
  if (idx.status === -1 || (idx.summary === -1 && idx.key === -1)) {
    throw new ValidationError(
      "Bu bir Jira issue CSV dışa aktarımına benzemiyor (Status/Summary sütunu bulunamadı)",
    );
  }

  const cards: ParsedCard[] = [];
  for (const satir of veriSatirlari) {
    if (satir.every((h) => h.trim() === "")) continue;

    const durum = (idx.status !== -1 ? satir[idx.status] : "")?.trim() || "(durumsuz)";
    const ozet = (idx.summary !== -1 ? satir[idx.summary] : "")?.trim();
    const anahtar = (idx.key !== -1 ? satir[idx.key] : "")?.trim();
    const atanan = idx.assignee !== -1 ? satir[idx.assignee]?.trim() : "";
    const oncelikHam = idx.priority !== -1 ? satir[idx.priority]?.trim().toLowerCase() : "";
    const etiketlerHam = idx.labels !== -1 ? satir[idx.labels]?.trim() : "";

    cards.push({
      sourceColumnId: durum,
      title: (ozet || anahtar || "(başlıksız)").slice(0, 500),
      description: idx.description !== -1 ? satir[idx.description]?.trim() || undefined : undefined,
      labels: etiketlerHam ? etiketlerHam.split(/[\s,]+/).filter(Boolean) : [],
      assigneeIdentifiers: atanan ? [atanan] : [],
      checklistItems: [],
      priority: oncelikHam ? JIRA_ONCELIK_ESLESMESI[oncelikHam] : undefined,
    });
  }

  const kartSayisi = new Map<string, number>();
  const sira: string[] = [];
  for (const k of cards) {
    if (!kartSayisi.has(k.sourceColumnId)) sira.push(k.sourceColumnId);
    kartSayisi.set(k.sourceColumnId, (kartSayisi.get(k.sourceColumnId) ?? 0) + 1);
  }
  const columns: ParsedColumn[] = sira.map((id) => ({ sourceId: id, name: id }));

  return { columns, cards };
}

// Ayristirilan panonun BOYUTU icin ust sinir. import.schema.ts yalnizca METIN
// boyutunu (5MB) siniriyor; 5MB'lik minimal bir Trello JSON'u ya da Jira CSV'si
// on binlerce kart uretebiliyor - ustelik Jira'da her farkli Status ayri bir
// sutun demek ve sutunlar dongude TEK TEK create ediliyor. Sinir olmadan tek
// istek paylasilan pooler'i tuketip yarim aktarilmis bir pano birakabiliyordu.
const MAX_IMPORT_CARDS = 2000;
const MAX_IMPORT_COLUMNS = 50;

function dosyayiAyristir(format: ImportFormat, icerik: string): ParsedImport {
  const ayristirilan = format === "TRELLO_JSON" ? ayristirTrelloJson(icerik) : ayristirJiraCsv(icerik);
  if (ayristirilan.cards.length > MAX_IMPORT_CARDS) {
    throw new ValidationError(
      `Tek seferde en fazla ${MAX_IMPORT_CARDS} kart içe aktarılabilir (dosyada ${ayristirilan.cards.length} kart var)`,
    );
  }
  if (ayristirilan.columns.length > MAX_IMPORT_COLUMNS) {
    throw new ValidationError(
      `Tek seferde en fazla ${MAX_IMPORT_COLUMNS} sütun içe aktarılabilir (dosyada ${ayristirilan.columns.length} sütun var)`,
    );
  }
  return ayristirilan;
}

// ------------------------------------------------------------ kullanici eslesmesi

interface OrgUye {
  userId: string;
  name: string;
  email: string;
}

function kullaniciEslestir(identifier: string, uyeler: OrgUye[]): OrgUye | null {
  const temiz = identifier.trim();
  if (!temiz) return null;
  const kucuk = temiz.toLowerCase();

  if (temiz.includes("@")) {
    const eposta = uyeler.find((u) => u.email.toLowerCase() === kucuk);
    if (eposta) return eposta;
  }

  return (
    uyeler.find((u) => u.name.toLowerCase() === kucuk) ??
    uyeler.find((u) => u.email.toLowerCase().split("@")[0] === kucuk) ??
    null
  );
}

// ------------------------------------------------------------ on izleme (kuru calisma)

export interface ImportPreview {
  format: ImportFormat;
  totalCards: number;
  columns: { sourceId: string; name: string; cardCount: number; suggestedColumnId: string | null }[];
  existingColumns: { id: string; name: string }[];
  labels: { name: string; cardCount: number }[];
  assignees: { identifier: string; cardCount: number; matchedUserId: string | null; matchedUserName: string | null }[];
}

export async function previewImport(
  projectId: string,
  format: ImportFormat,
  fileContent: string,
  userId: string,
): Promise<ImportPreview> {
  const { role, organizationId } = await checkProjectAccess(projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("İçe aktarmayı sadece adminler yapabilir");

  const parsed = dosyayiAyristir(format, fileContent);

  const [mevcutKolonlar, orgUyeleri] = await Promise.all([
    prisma.column.findMany({ where: { projectId }, select: { id: true, name: true } }),
    prisma.organizationMember.findMany({
      where: { organizationId },
      select: { userId: true, user: { select: { name: true, email: true } } },
    }),
  ]);

  const uyeler: OrgUye[] = orgUyeleri.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email }));
  const normalize = (s: string) => s.trim().toLowerCase();

  const kartSayisiByKolon = new Map<string, number>();
  for (const k of parsed.cards) kartSayisiByKolon.set(k.sourceColumnId, (kartSayisiByKolon.get(k.sourceColumnId) ?? 0) + 1);

  const columns = parsed.columns.map((c) => {
    const eslesen = mevcutKolonlar.find((mk) => normalize(mk.name) === normalize(c.name));
    return {
      sourceId: c.sourceId,
      name: c.name,
      cardCount: kartSayisiByKolon.get(c.sourceId) ?? 0,
      suggestedColumnId: eslesen?.id ?? null,
    };
  });

  const etiketSayisi = new Map<string, number>();
  for (const k of parsed.cards) {
    for (const etiket of k.labels) etiketSayisi.set(etiket, (etiketSayisi.get(etiket) ?? 0) + 1);
  }
  const labels = Array.from(etiketSayisi.entries()).map(([name, cardCount]) => ({ name, cardCount }));

  const atananSayisi = new Map<string, number>();
  for (const k of parsed.cards) {
    for (const kimlik of k.assigneeIdentifiers) atananSayisi.set(kimlik, (atananSayisi.get(kimlik) ?? 0) + 1);
  }
  const assignees = Array.from(atananSayisi.entries()).map(([identifier, cardCount]) => {
    const eslesen = kullaniciEslestir(identifier, uyeler);
    return {
      identifier,
      cardCount,
      matchedUserId: eslesen?.userId ?? null,
      matchedUserName: eslesen?.name ?? null,
    };
  });

  return {
    format,
    totalCards: parsed.cards.length,
    columns,
    existingColumns: mevcutKolonlar,
    labels,
    assignees,
  };
}

// ------------------------------------------------------------ uygula (kume bazli yazim)

export interface ApplyImportResult {
  createdColumns: number;
  createdCards: number;
  createdLabels: number;
  skippedCards: number;
}

export async function applyImport(
  projectId: string,
  format: ImportFormat,
  fileContent: string,
  columnMapping: Record<string, ColumnMappingEntry>,
  userMapping: Record<string, string | null>,
  userId: string,
): Promise<ApplyImportResult> {
  const { role, organizationId } = await checkProjectAccess(projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("İçe aktarmayı sadece adminler yapabilir");

  const parsed = dosyayiAyristir(format, fileContent);

  // --- 0) userMapping govdeden geliyor ve sema onu sadece "string" olarak
  // dogruluyor; previewImport'un eslestirmesi yalnizca ONERI, apply bu degeri
  // tekrar dogrulamak zorunda. Kontrol olmadan (a) baska bir organizasyonun
  // kullanici id'si gonderilip o kisi hic uyesi olmadigi projedeki kartlara
  // atanmis gorunebiliyor, (b) var olmayan bir id CardAssignee createMany'yi
  // yabanci anahtar hatasiyla patlatiyor - kartlar/etiketler o noktada coktan
  // yazilmis oluyordu. Yazimlardan ONCE, tek sorguda dogruluyoruz.
  const istenenUserIdler = [...new Set(Object.values(userMapping).filter((v): v is string => !!v))];
  if (istenenUserIdler.length > 0) {
    const uyeSayisi = await prisma.organizationMember.count({
      where: { organizationId, userId: { in: istenenUserIdler } },
    });
    if (uyeSayisi !== istenenUserIdler.length) {
      throw new ValidationError("Eşleştirilen kullanıcılardan biri bu organizasyonun üyesi değil");
    }
  }

  // --- 1) Hedef kolonlari coz: mevcut / yeni-olustur / atla. Yeni kolon
  // sayisi tipik olarak kucuk (bir kac liste/durum) - tek tek create() kabul
  // edilebilir, kartlar gibi yuzlerce degil.
  const mevcutKolonlar = await prisma.column.findMany({
    where: { projectId },
    select: { id: true, position: true },
    orderBy: { position: "desc" },
  });
  let sonPozisyon = mevcutKolonlar[0]?.position ?? 0;

  // Govdeden gelen "existing" hedef sutun ID'si icin izin listesi. Bu kontrol
  // olmadan cagiran, kendi projesine erisim yetkisiyle BASKA bir projenin
  // (hatta baska kiracinin) sutun id'sini gonderip oraya kart yazdirabilir:
  // kartin projesi Column uzerinden bulundugu icin ne sema (projectId,number
  // tekilligi DB'de yok) ne de asagidaki geri-okuma bunu yakalar.
  // Dogrulama asagidaki donguden ONCE toplu yapiliyor: dongu icinde "new"
  // eslemeleri icin gercek kolon yaratiliyor, ortasinda hata firlatirsak
  // yarim kalmis kolonlar geride kalirdi.
  const projeninKolonIdleri = new Set(mevcutKolonlar.map((k) => k.id));
  for (const kolon of parsed.columns) {
    const esleme = columnMapping[kolon.sourceId];
    if (esleme?.mode === "existing" && !projeninKolonIdleri.has(esleme.columnId)) {
      throw new ValidationError("Hedef sütun bu projeye ait değil");
    }
  }

  const kaynakKolonHedefi = new Map<string, string | null>(); // sourceColumnId -> hedef columnId | null(atla)
  let olusturulanKolonSayisi = 0;
  for (const kolon of parsed.columns) {
    const esleme = columnMapping[kolon.sourceId];
    if (!esleme || esleme.mode === "skip") {
      kaynakKolonHedefi.set(kolon.sourceId, null);
      continue;
    }
    if (esleme.mode === "existing") {
      kaynakKolonHedefi.set(kolon.sourceId, esleme.columnId);
      continue;
    }
    sonPozisyon += 1;
    const yeni = await prisma.column.create({
      data: { projectId, name: esleme.name, position: sonPozisyon },
      select: { id: true },
    });
    olusturulanKolonSayisi++;
    kaynakKolonHedefi.set(kolon.sourceId, yeni.id);
  }

  const alinacakKartlar = parsed.cards.filter((k) => kaynakKolonHedefi.get(k.sourceColumnId));
  const atlananKartSayisi = parsed.cards.length - alinacakKartlar.length;

  if (alinacakKartlar.length === 0) {
    return { createdColumns: olusturulanKolonSayisi, createdCards: 0, createdLabels: 0, skippedCards: atlananKartSayisi };
  }

  // --- 2-7) Sayac artisindan checklist yazimina kadar TUM adimlar TEK
  // transaction'da. Onceden her adim ayri kosuyordu: ortada dusen bir hata
  // (or. pooler kopmasi) kartlari yazilmis ama checklist'i/atamasi eksik bir
  // pano ve tuketilmis bir kart sayaci birakiyor, kullanici "tekrar dene"
  // dediginde ayni kartlar ikinci kez ekleniyordu. Artik ya hepsi ya hicbiri.
  const olusturulanEtiketSayisi = await prisma.$transaction(
    async (tx) => {
      // --- 2) Kart numaralarini TEK sayac artisiyla topluca ayir (bkz. dosya basi not).
      const guncelProje = await tx.project.update({
        where: { id: projectId },
        data: { cardCounter: { increment: alinacakKartlar.length } },
        select: { cardCounter: true },
      });
      const ilkNumara = guncelProje.cardCounter - alinacakKartlar.length + 1;

      // --- 3) Hedef kolon basina baslangic pozisyonunu bir kez oku.
      const hedefKolonIdleri = [...new Set([...kaynakKolonHedefi.values()].filter((v): v is string => !!v))];
      const kolonSonPozisyonlari = await tx.column.findMany({
        where: { id: { in: hedefKolonIdleri } },
        select: { id: true, cards: { orderBy: { position: "desc" }, take: 1, select: { position: true } } },
      });
      const pozisyonSayaci = new Map<string, number>(
        kolonSonPozisyonlari.map((k) => [k.id, k.cards[0]?.position ?? 0]),
      );

      const cardsData: Prisma.CardCreateManyInput[] = alinacakKartlar.map((kart, i) => {
        const hedefKolon = kaynakKolonHedefi.get(kart.sourceColumnId)!;
        const pozisyon = (pozisyonSayaci.get(hedefKolon) ?? 0) + 1;
        pozisyonSayaci.set(hedefKolon, pozisyon);
        return {
          columnId: hedefKolon,
          number: ilkNumara + i,
          title: kart.title,
          description: kart.description,
          creatorId: userId,
          priority: kart.priority ?? "MEDIUM",
          position: pozisyon,
        };
      });

      await tx.card.createMany({ data: cardsData });

      // --- 4) Yeni kartlarin id'lerini numaradan TEK sorguda geri oku (numara
      // proje icinde tekil - sayaçtan geliyor).
      const olusanKartlar = await tx.card.findMany({
        where: { column: { projectId }, number: { gte: ilkNumara, lte: ilkNumara + alinacakKartlar.length - 1 } },
        select: { id: true, number: true },
      });
      // Geri okuma sonraki adimlarin on kosulu: eksik donerse etiket/atama/
      // checklist baglantilari SESSIZCE atlanip islem yine "basarili"
      // raporlaniyordu. Artik transaction'i geri sariyoruz.
      if (olusanKartlar.length !== alinacakKartlar.length) {
        throw new ValidationError("İçe aktarma doğrulanamadı, hiçbir değişiklik uygulanmadı");
      }
      const idByNumara = new Map(olusanKartlar.map((k) => [k.number, k.id]));

      // --- 5) Etiketler: eksik olanlari topluca olustur, hepsini isimden id'ye
      // TEK sorguda coz, sonra kart-etiket baglantilarini TEK createMany ile ekle.
      const tumEtiketAdlari = [...new Set(alinacakKartlar.flatMap((k) => k.labels))];
      let etiketSayisi = 0;
      if (tumEtiketAdlari.length > 0) {
        const mevcutEtiketler = await tx.label.findMany({
          where: { projectId, name: { in: tumEtiketAdlari } },
          select: { id: true, name: true },
        });
        const mevcutAdlar = new Set(mevcutEtiketler.map((e) => e.name));
        const eksikAdlar = tumEtiketAdlari.filter((ad) => !mevcutAdlar.has(ad));
        if (eksikAdlar.length > 0) {
          const renkler = ["#EF4444", "#F97316", "#EAB308", "#22C55E", "#3B82F6", "#8B5CF6", "#EC4899"];
          await tx.label.createMany({
            data: eksikAdlar.map((ad, i) => ({ projectId, name: ad, color: renkler[i % renkler.length] })),
          });
          etiketSayisi = eksikAdlar.length;
        }
        const tumEtiketler = await tx.label.findMany({
          where: { projectId, name: { in: tumEtiketAdlari } },
          select: { id: true, name: true },
        });
        const etiketIdByAd = new Map(tumEtiketler.map((e) => [e.name, e.id]));

        const cardLabelData = alinacakKartlar.flatMap((kart, i) => {
          const cardId = idByNumara.get(ilkNumara + i);
          if (!cardId) return [];
          return kart.labels.map((ad) => ({ cardId, labelId: etiketIdByAd.get(ad)! })).filter((cl) => cl.labelId);
        });
        if (cardLabelData.length > 0) {
          await tx.cardLabel.createMany({ data: cardLabelData, skipDuplicates: true });
        }
      }

      // --- 6) Atamalar: kaynak kimlikten (isim/e-posta) kullaniciMapping ile
      // gelen userId'yi kullan (0. adimda organizasyon uyeligine karsi
      // dogrulandi), TEK createMany.
      const cardAssigneeData = alinacakKartlar.flatMap((kart, i) => {
        const cardId = idByNumara.get(ilkNumara + i);
        if (!cardId) return [];
        const userIdler = [...new Set(kart.assigneeIdentifiers.map((kimlik) => userMapping[kimlik]).filter((v): v is string => !!v))];
        return userIdler.map((uId) => ({ cardId, userId: uId }));
      });
      if (cardAssigneeData.length > 0) {
        await tx.cardAssignee.createMany({ data: cardAssigneeData, skipDuplicates: true });
      }

      // --- 7) Checklist ogeleri: TEK createMany.
      const checklistData = alinacakKartlar.flatMap((kart, i) => {
        const cardId = idByNumara.get(ilkNumara + i);
        if (!cardId) return [];
        return kart.checklistItems.map((item, pos) => ({
          cardId,
          text: item.text.slice(0, 500),
          done: item.done,
          position: pos + 1,
        }));
      });
      if (checklistData.length > 0) {
        await tx.checklistItem.createMany({ data: checklistData });
      }

      return etiketSayisi;
    },
    // Prisma'nin varsayilan 5 sn'lik transaction penceresi MAX_IMPORT_CARDS
    // kadar kart + etiket + checklist yazimina yetmiyor; pencere tavana gore
    // genisletiliyor.
    { maxWait: 15_000, timeout: 120_000 },
  );

  return {
    createdColumns: olusturulanKolonSayisi,
    createdCards: alinacakKartlar.length,
    createdLabels: olusturulanEtiketSayisi,
    skippedCards: atlananKartSayisi,
  };
}
