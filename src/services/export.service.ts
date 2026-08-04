import ExcelJS from "exceljs";

// Pano disa aktarimi.
//
// Onceki surum yalnizca ham CSV uretiyordu ve pratikte kullanilamiyordu:
// Excel dosyayi ne kadar dogru yazarsak yazalim TEK SUTUN halinde aciyordu
// (Turkce Windows'ta liste ayraci ";" iken biz "," yaziyorduk) ve BOM
// olmadigi icin turkce karakterler bozuk gorunuyordu. Yani ozellik "vardi"
// ama ciktisi bir tabloya benzemiyordu.
//
// Cozum ayraci degistirmek degil - Excel'in ayrac tahminine hic guvenmemek:
// birincil format artik gercek .xlsx. Bicimlendirme, tarih tipleri, filtre
// ve donmus baslik dosyanin kendi icinde tasindigi icin hangi bilgisayarda
// acilirsa acilsin ayni gorunuyor. CSV ve JSON, programatik kullanim ve
// yedekleme icin ikincil secenek olarak duruyor.

export type ExportFormat = "xlsx" | "csv" | "json";
export type ExportDil = "tr" | "en";

export interface BoardTask {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  startDate: string | null;
  columnId: string;
  position: number;
  priority: string;
  lastActivityAt: string;
  assignees: { id: string; name: string }[];
  labels: { id: string; name: string; color: string }[];
  checklistTotal: number;
  checklistDone: number;
}

export interface BoardShape {
  columns: Record<
    string,
    { id: string; title: string; wipLimit: number | null; isDone: boolean; taskIds: string[] }
  >;
  tasks: Record<string, unknown>;
}

/** Kolon sirasi + kart sirasi korunarak duzlestirilmis satirlar. */
interface DuzSatir {
  kolon: string;
  kolonBitti: boolean;
  gorev: BoardTask;
}

function duzlestir(board: BoardShape): DuzSatir[] {
  const satirlar: DuzSatir[] = [];
  for (const kolon of Object.values(board.columns)) {
    for (const taskId of kolon.taskIds) {
      const gorev = board.tasks[taskId] as BoardTask | undefined;
      if (!gorev) continue;
      satirlar.push({ kolon: kolon.title, kolonBitti: kolon.isDone, gorev });
    }
  }
  return satirlar;
}

// ---------------------------------------------------------------- ceviriler

const METINLER = {
  tr: {
    sheetGorevler: "Görevler",
    sheetOzet: "Özet",
    kolon: "Kolon",
    baslik: "Başlık",
    oncelik: "Öncelik",
    atananlar: "Atananlar",
    etiketler: "Etiketler",
    baslangic: "Başlangıç",
    bitis: "Bitiş",
    kontrolListesi: "Kontrol Listesi",
    ilerleme: "İlerleme",
    sonHareket: "Son Hareket",
    aciklama: "Açıklama",
    kartId: "Kart ID",
    proje: "Proje",
    disaAktarma: "Dışa aktarma",
    toplamGorev: "Toplam görev",
    kolonBazinda: "Kolon bazında",
    oncelikBazinda: "Öncelik bazında",
    kisiBazinda: "Kişi bazında",
    gorevSayisi: "Görev sayısı",
    kisi: "Kişi",
    atanmamis: "Atanmamış",
    pay: "Pay",
    LOW: "Düşük",
    MEDIUM: "Orta",
    HIGH: "Yüksek",
    URGENT: "Acil",
  },
  en: {
    sheetGorevler: "Tasks",
    sheetOzet: "Summary",
    kolon: "Column",
    baslik: "Title",
    oncelik: "Priority",
    atananlar: "Assignees",
    etiketler: "Labels",
    baslangic: "Start",
    bitis: "Due",
    kontrolListesi: "Checklist",
    ilerleme: "Progress",
    sonHareket: "Last Activity",
    aciklama: "Description",
    kartId: "Card ID",
    proje: "Project",
    disaAktarma: "Exported",
    toplamGorev: "Total tasks",
    kolonBazinda: "By column",
    oncelikBazinda: "By priority",
    kisiBazinda: "By assignee",
    gorevSayisi: "Task count",
    kisi: "Person",
    atanmamis: "Unassigned",
    pay: "Share",
    LOW: "Low",
    MEDIUM: "Medium",
    HIGH: "High",
    URGENT: "Urgent",
  },
} as const;

// Deger tipleri string'e genisletiliyor: "as const" her metni kendi harfi
// harfine tipine cevirdigi icin, daraltilmamis hali tr ve en tablolarini
// birbirine uyumsuz kilardi.
type Metin = Record<keyof (typeof METINLER)["tr"], string>;

function oncelikEtiketi(m: Metin, priority: string): string {
  return (m as Record<string, string>)[priority] ?? priority;
}

// ------------------------------------------------------------------ renkler

const BASLIK_DOLGU = "FF1E293B"; // slate-800
const BANT_DOLGU = "FFF8FAFC"; // slate-50
const KENAR = "FFE2E8F0"; // slate-200

const ONCELIK_RENGI: Record<string, { dolgu: string; yazi: string }> = {
  URGENT: { dolgu: "FFFEE2E2", yazi: "FF991B1B" },
  HIGH: { dolgu: "FFFFEDD5", yazi: "FF9A3412" },
  MEDIUM: { dolgu: "FFFEF9C3", yazi: "FF854D0E" },
  LOW: { dolgu: "FFE0F2FE", yazi: "FF075985" },
};

// Her cagrida YENI nesne donuyor: ExcelJS atanan stil nesnesini mutasyona
// ugratiyor, paylasilan tek bir nesne sayfa genelinde yan etkiye yol aciyor.
function inceKenar(): Partial<ExcelJS.Borders> {
  const c = { style: "thin" as const, color: { argb: KENAR } };
  return { top: c, left: c, bottom: c, right: c };
}

// -------------------------------------------------------------------- xlsx

/**
 * Cok satirli aciklamalari tek satira indirger. Hucre icinde ham satir sonu
 * birakmak tabloyu okunamaz hale getiriyor (Excel ya satirlari asiri
 * yukseltiyor ya da yalnizca ilk satiri gosteriyor). Icerik kayb olmuyor,
 * yalnizca yeniden akitiliyor; kayipsiz kopya isteyen JSON formatini kullanir.
 */
function tekSatira(metin: string | null | undefined): string {
  if (!metin) return "";
  return metin.replace(/\s+/g, " ").trim();
}

/** Bos dizeyi null'a cevirir; Excel'de gercek bos hucre uretmek icin. */
function bosSuz(deger: string | null | undefined): string | null {
  return deger && deger.length > 0 ? deger : null;
}

function tariheCevir(deger: string | null | undefined): Date | null {
  if (!deger) return null;
  const d = new Date(deger);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function boardToXlsx(
  board: BoardShape,
  projeAdi: string,
  dil: ExportDil = "tr",
): Promise<Buffer> {
  const m = METINLER[dil];
  const satirlar = duzlestir(board);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Quantro";
  wb.created = new Date();

  // ---------------------------------------------------------- Gorevler sayfasi
  const ws = wb.addWorksheet(m.sheetGorevler, {
    views: [{ state: "frozen", ySplit: 1 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  ws.columns = [
    { header: m.kolon, key: "kolon", width: 18 },
    { header: m.baslik, key: "baslik", width: 46 },
    { header: m.oncelik, key: "oncelik", width: 11 },
    { header: m.atananlar, key: "atananlar", width: 24 },
    { header: m.etiketler, key: "etiketler", width: 22 },
    { header: m.baslangic, key: "baslangic", width: 12 },
    { header: m.bitis, key: "bitis", width: 12 },
    { header: m.kontrolListesi, key: "kontrol", width: 13 },
    { header: m.ilerleme, key: "ilerleme", width: 10 },
    { header: m.sonHareket, key: "sonHareket", width: 17 },
    { header: m.aciklama, key: "aciklama", width: 60 },
    { header: m.kartId, key: "kartId", width: 26 },
  ];

  const baslikSatiri = ws.getRow(1);
  baslikSatiri.height = 22;
  baslikSatiri.eachCell((hucre) => {
    hucre.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BASLIK_DOLGU } };
    hucre.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    hucre.alignment = { vertical: "middle", horizontal: "left" };
    hucre.border = inceKenar();
  });

  const bugun = new Date();
  bugun.setHours(0, 0, 0, 0);

  for (const [i, satir] of satirlar.entries()) {
    const g = satir.gorev;
    const bitis = tariheCevir(g.dueDate);

    const eklenen = ws.addRow({
      kolon: satir.kolon,
      baslik: g.title,
      oncelik: oncelikEtiketi(m, g.priority),
      // Bos degerler "" degil null: Excel'de bos dize DOLU hucre sayiliyor,
      // "Bosluklar" filtresi ve COUNTA yanlis sonuc veriyor.
      atananlar: bosSuz(g.assignees?.map((a) => a.name).join(", ")),
      etiketler: bosSuz(g.labels?.map((l) => l.name).join(", ")),
      baslangic: tariheCevir(g.startDate),
      bitis,
      kontrol:
        (g.checklistTotal ?? 0) > 0 ? `${g.checklistDone ?? 0}/${g.checklistTotal}` : null,
      ilerleme:
        (g.checklistTotal ?? 0) > 0 ? (g.checklistDone ?? 0) / g.checklistTotal : null,
      sonHareket: tariheCevir(g.lastActivityAt),
      aciklama: bosSuz(tekSatira(g.description)),
      kartId: g.id,
    });

    eklenen.alignment = { vertical: "middle" };
    eklenen.border = inceKenar();

    // Zebra desen: 500 satirlik bir panoda satir takibini kolaylastiriyor.
    if (i % 2 === 1) {
      eklenen.eachCell({ includeEmpty: true }, (hucre) => {
        hucre.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BANT_DOLGU } };
      });
    }

    const oncelikHucresi = eklenen.getCell("oncelik");
    const renk = ONCELIK_RENGI[g.priority];
    if (renk) {
      oncelikHucresi.fill = { type: "pattern", pattern: "solid", fgColor: { argb: renk.dolgu } };
      oncelikHucresi.font = { bold: true, color: { argb: renk.yazi } };
      oncelikHucresi.alignment = { vertical: "middle", horizontal: "center" };
    }

    // Tarihler gercek tarih hucresi - metin degil. Boylece Excel'de
    // siralanabiliyor, filtrelenebiliyor ve formullerde kullanilabiliyor.
    for (const anahtar of ["baslangic", "bitis"] as const) {
      eklenen.getCell(anahtar).numFmt = "dd.mm.yyyy";
      eklenen.getCell(anahtar).alignment = { vertical: "middle", horizontal: "center" };
    }
    eklenen.getCell("sonHareket").numFmt = "dd.mm.yyyy hh:mm";
    eklenen.getCell("sonHareket").alignment = { vertical: "middle", horizontal: "center" };

    eklenen.getCell("ilerleme").numFmt = "0%";
    eklenen.getCell("ilerleme").alignment = { vertical: "middle", horizontal: "center" };
    eklenen.getCell("kontrol").alignment = { vertical: "middle", horizontal: "center" };

    // Gecikmis is: bitis tarihi gecmis ve kolon "bitti" degil.
    if (bitis && bitis < bugun && !satir.kolonBitti) {
      eklenen.getCell("bitis").font = { bold: true, color: { argb: "FFB91C1C" } };
    }

    eklenen.getCell("kartId").font = { size: 9, color: { argb: "FF94A3B8" } };
  }

  // Otomatik filtre: kullanicinin Excel'de kolona/onceliğe/kisiye gore
  // suzebilmesi, bu ciktinin rapor olarak ise yaramasinin asil sebebi.
  if (satirlar.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  }

  // ------------------------------------------------------------ Ozet sayfasi
  const ozet = wb.addWorksheet(m.sheetOzet, {
    views: [{ showGridLines: false }],
  });
  ozet.columns = [
    { key: "a", width: 30 },
    { key: "b", width: 14 },
    { key: "c", width: 10 },
  ];

  const baslikYaz = (metin: string) => {
    const r = ozet.addRow([metin]);
    r.getCell(1).font = { bold: true, size: 13, color: { argb: "FF0F172A" } };
    r.height = 24;
    return r;
  };

  const tabloBasligi = (a: string, b: string, c: string) => {
    const r = ozet.addRow([a, b, c]);
    r.eachCell((hucre) => {
      hucre.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BASLIK_DOLGU } };
      hucre.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
      hucre.border = inceKenar();
    });
    return r;
  };

  const toplam = satirlar.length;
  const sayimTablosu = (girdiler: [string, number][]) => {
    for (const [ad, adet] of girdiler) {
      const r = ozet.addRow([ad, adet, toplam > 0 ? adet / toplam : 0]);
      r.getCell(2).alignment = { horizontal: "center" };
      r.getCell(3).numFmt = "0%";
      r.getCell(3).alignment = { horizontal: "center" };
      r.eachCell((hucre) => {
        hucre.border = inceKenar();
      });
    }
    ozet.addRow([]);
  };

  const projeSatiri = ozet.addRow([`${m.proje}: ${projeAdi}`]);
  projeSatiri.getCell(1).font = { bold: true, size: 16, color: { argb: "FF0F172A" } };
  projeSatiri.height = 28;
  ozet.addRow([
    `${m.disaAktarma}: ${new Date().toLocaleString(dil === "tr" ? "tr-TR" : "en-US")}`,
  ]).getCell(1).font = { size: 10, color: { argb: "FF64748B" } };
  ozet.addRow([`${m.toplamGorev}: ${toplam}`]).getCell(1).font = {
    size: 10,
    color: { argb: "FF64748B" },
  };
  ozet.addRow([]);

  // Kolon bazinda
  baslikYaz(m.kolonBazinda);
  tabloBasligi(m.kolon, m.gorevSayisi, m.pay);
  sayimTablosu(
    Object.values(board.columns).map((k) => [k.title, k.taskIds.length] as [string, number]),
  );

  // Oncelik bazinda - sabit sira (Acil -> Dusuk), sifir olanlar da gorunur
  // kalsin ki "hic acil is yok" bilgisi de raporda okunabilsin.
  baslikYaz(m.oncelikBazinda);
  tabloBasligi(m.oncelik, m.gorevSayisi, m.pay);
  const oncelikSirasi = ["URGENT", "HIGH", "MEDIUM", "LOW"];
  sayimTablosu(
    oncelikSirasi.map(
      (p) =>
        [oncelikEtiketi(m, p), satirlar.filter((s) => s.gorev.priority === p).length] as [
          string,
          number,
        ],
    ),
  );

  // Kisi bazinda
  baslikYaz(m.kisiBazinda);
  tabloBasligi(m.kisi, m.gorevSayisi, m.pay);
  const kisiSayaci = new Map<string, number>();
  let atanmamis = 0;
  for (const s of satirlar) {
    const atananlar = s.gorev.assignees ?? [];
    if (atananlar.length === 0) {
      atanmamis += 1;
      continue;
    }
    for (const a of atananlar) {
      kisiSayaci.set(a.name, (kisiSayaci.get(a.name) ?? 0) + 1);
    }
  }
  const kisiGirdileri: [string, number][] = [...kisiSayaci.entries()].sort((x, y) => y[1] - x[1]);
  if (atanmamis > 0) kisiGirdileri.push([m.atanmamis, atanmamis]);
  sayimTablosu(kisiGirdileri);

  const arabellek = await wb.xlsx.writeBuffer();
  return Buffer.from(arabellek as ArrayBuffer);
}

// --------------------------------------------------------------------- csv

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * RFC 4180 uyumlu CSV: virgul ayrac, CRLF satir sonu, basta UTF-8 BOM.
 *
 * BOM olmadan Excel dosyayi sistem kod sayfasiyla okuyor ve turkce
 * karakterler bozuluyordu. Ayraci ";" yapip Excel'i memnun etmek yerine
 * standarda sadik kaliyoruz - Excel isteyen kullanici xlsx formatini
 * kullanir, bu format ise betikler ve diger araclar icin.
 */
export function boardToCsv(board: BoardShape): string {
  const basliklar = [
    "column",
    "card_id",
    "title",
    "priority",
    "start_date",
    "due_date",
    "assignees",
    "labels",
    "checklist_done",
    "checklist_total",
    "last_activity_at",
    "description",
  ];
  const satirlar: string[] = [basliklar.join(",")];

  for (const satir of duzlestir(board)) {
    const g = satir.gorev;
    satirlar.push(
      [
        csvEscape(satir.kolon),
        csvEscape(g.id),
        csvEscape(g.title),
        csvEscape(g.priority),
        csvEscape(g.startDate),
        csvEscape(g.dueDate),
        csvEscape(g.assignees?.map((a) => a.name).join("; ")),
        csvEscape(g.labels?.map((l) => l.name).join("; ")),
        csvEscape(g.checklistDone ?? 0),
        csvEscape(g.checklistTotal ?? 0),
        csvEscape(g.lastActivityAt),
        csvEscape(g.description),
      ].join(","),
    );
  }

  return `﻿${satirlar.join("\r\n")}`;
}

// ------------------------------------------------------------------ dosya adi

/**
 * Dosya adini guvenli hale getirir. Proje adi kullanici girdisi oldugu icin
 * Content-Disposition basligina dogrudan konulamaz: tirnak veya satir sonu
 * iceren bir ad baslik enjeksiyonuna acik olurdu.
 */
export function dosyaAdiUret(projeAdi: string, uzanti: string): { ascii: string; utf8: string } {
  const tarih = new Date().toISOString().split("T")[0];
  const temiz = projeAdi.replace(/[\r\n"\\/:*?<>|]/g, "").trim() || "board";
  const utf8 = `${temiz}-${tarih}.${uzanti}`;
  // ASCII yedegi: eski istemciler filename* alanini anlamiyor.
  const ascii = utf8.replace(/[^\x20-\x7E]/g, "_");
  return { ascii, utf8 };
}
