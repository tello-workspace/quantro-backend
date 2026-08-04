import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  boardToCsv,
  boardToXlsx,
  dosyaAdiUret,
  type BoardShape,
} from "@/services/export.service";

// Disa aktarma cikitisinin GERCEKTEN bir tablo oldugunu dogruluyoruz:
// uretilen .xlsx tekrar okunup hucre hucre kontrol ediliyor. Onceki surumde
// cikti ham CSV idi ve Excel'de tek sutun halinde aciliyordu - "dosya
// indirildi" testi bu hatayi yakalayamazdi, o yuzden icerigi okuyoruz.

function ornekBoard(): BoardShape {
  return {
    columns: {
      c1: { id: "c1", title: "Yapılacak", wipLimit: null, isDone: false, taskIds: ["t1", "t2"] },
      c2: { id: "c2", title: "Bitti", wipLimit: null, isDone: true, taskIds: ["t3"] },
      c3: { id: "c3", title: "Boş Kolon", wipLimit: null, isDone: false, taskIds: [] },
    },
    tasks: {
      t1: {
        id: "t1",
        title: "Ödeme ekranı",
        description: "Çok satırlı\naçıklama\n\nikinci paragraf",
        dueDate: "2020-01-15",
        startDate: "2020-01-01",
        columnId: "c1",
        position: 0,
        priority: "URGENT",
        lastActivityAt: "2020-01-10T08:30:00.000Z",
        assignees: [
          { id: "u1", name: "Mert Şafak" },
          { id: "u2", name: "Ayşe Yılmaz" },
        ],
        labels: [{ id: "l1", name: "backend", color: "#fff" }],
        checklistTotal: 4,
        checklistDone: 1,
      },
      t2: {
        id: "t2",
        title: 'Virgüllü, "tırnaklı" başlık',
        description: null,
        dueDate: null,
        startDate: null,
        columnId: "c1",
        position: 1,
        priority: "LOW",
        lastActivityAt: "2020-02-01T00:00:00.000Z",
        assignees: [],
        labels: [],
        checklistTotal: 0,
        checklistDone: 0,
      },
      t3: {
        id: "t3",
        title: "Tamamlanan iş",
        description: "kısa",
        dueDate: "2020-01-05",
        startDate: null,
        columnId: "c2",
        position: 0,
        priority: "MEDIUM",
        lastActivityAt: "2020-01-06T00:00:00.000Z",
        assignees: [{ id: "u1", name: "Mert Şafak" }],
        labels: [],
        checklistTotal: 2,
        checklistDone: 2,
      },
    },
  };
}

// Sutun anahtarlari ("key") ExcelJS'in bellek ici kolayligi; xlsx formatinda
// SAKLANMIYOR. Dosyayi geri okudugumuzda getCell(S.bitis) calismaz, bu yuzden
// testler sutunlara indeksle bakiyor.
const S = {
  kolon: 1,
  baslik: 2,
  oncelik: 3,
  atananlar: 4,
  etiketler: 5,
  baslangic: 6,
  bitis: 7,
  kontrol: 8,
  ilerleme: 9,
  sonHareket: 10,
  aciklama: 11,
  kartId: 12,
} as const;

async function xlsxOku(arabellek: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS'in Node tarafi ArrayBuffer bekliyor.
  await wb.xlsx.load(
    arabellek.buffer.slice(
      arabellek.byteOffset,
      arabellek.byteOffset + arabellek.byteLength,
    ) as ArrayBuffer,
  );
  return wb;
}

describe("boardToXlsx", () => {
  it("gecerli bir Excel dosyasi uretir ve iki sayfa icerir", async () => {
    const wb = await xlsxOku(await boardToXlsx(ornekBoard(), "Quantro", "tr"));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Görevler", "Özet"]);
  });

  it("her kart AYRI satir, her alan AYRI sutun olarak yazilir", async () => {
    const wb = await xlsxOku(await boardToXlsx(ornekBoard(), "Quantro", "tr"));
    const ws = wb.getWorksheet("Görevler")!;

    // 1 baslik + 3 kart. Bos kolon satir uretmez.
    expect(ws.rowCount).toBe(4);

    const basliklar = (ws.getRow(1).values as unknown[]).slice(1);
    expect(basliklar).toEqual([
      "Kolon",
      "Başlık",
      "Öncelik",
      "Atananlar",
      "Etiketler",
      "Başlangıç",
      "Bitiş",
      "Kontrol Listesi",
      "İlerleme",
      "Son Hareket",
      "Açıklama",
      "Kart ID",
    ]);

    const ilkSatir = ws.getRow(2);
    expect(ilkSatir.getCell(S.kolon).value).toBe("Yapılacak");
    expect(ilkSatir.getCell(S.baslik).value).toBe("Ödeme ekranı");
    expect(ilkSatir.getCell(S.oncelik).value).toBe("Acil");
    expect(ilkSatir.getCell(S.atananlar).value).toBe("Mert Şafak, Ayşe Yılmaz");
    expect(ilkSatir.getCell(S.etiketler).value).toBe("backend");
    expect(ilkSatir.getCell(S.kontrol).value).toBe("1/4");
    expect(ilkSatir.getCell(S.kartId).value).toBe("t1");
  });

  it("kolon sirasini ve kolon icindeki kart sirasini korur", async () => {
    const wb = await xlsxOku(await boardToXlsx(ornekBoard(), "Quantro", "tr"));
    const ws = wb.getWorksheet("Görevler")!;
    expect([2, 3, 4].map((n) => ws.getRow(n).getCell(S.kartId).value)).toEqual(["t1", "t2", "t3"]);
  });

  it("tarihleri METIN degil gercek tarih hucresi olarak yazar", async () => {
    const wb = await xlsxOku(await boardToXlsx(ornekBoard(), "Quantro", "tr"));
    const ws = wb.getWorksheet("Görevler")!;
    const bitis = ws.getRow(2).getCell(S.bitis);

    // Metin olsaydi Excel'de siralama/filtreleme alfabetik olurdu.
    expect(bitis.value).toBeInstanceOf(Date);
    expect((bitis.value as Date).toISOString().split("T")[0]).toBe("2020-01-15");
    expect(bitis.numFmt).toBe("dd.mm.yyyy");
  });

  it("ilerlemeyi yuzde bicimli SAYI olarak yazar", async () => {
    const wb = await xlsxOku(await boardToXlsx(ornekBoard(), "Quantro", "tr"));
    const ws = wb.getWorksheet("Görevler")!;
    const ilerleme = ws.getRow(2).getCell(S.ilerleme);
    expect(ilerleme.value).toBeCloseTo(0.25);
    expect(ilerleme.numFmt).toBe("0%");
  });

  it("kontrol listesi olmayan kartta ilerlemeyi bos birakir (0% degil)", async () => {
    // 0% yazmak "hic ilerlememis" anlamina gelirdi; madde YOK demek baska sey.
    const wb = await xlsxOku(await boardToXlsx(ornekBoard(), "Quantro", "tr"));
    const ws = wb.getWorksheet("Görevler")!;
    expect(ws.getRow(3).getCell(S.ilerleme).value).toBeNull();
    expect(ws.getRow(3).getCell(S.kontrol).value).toBeNull();
  });

  it("cok satirli aciklamayi tek satira indirger", async () => {
    const wb = await xlsxOku(await boardToXlsx(ornekBoard(), "Quantro", "tr"));
    const ws = wb.getWorksheet("Görevler")!;
    expect(ws.getRow(2).getCell(S.aciklama).value).toBe(
      "Çok satırlı açıklama ikinci paragraf",
    );
  });

  it("basligi dondurur ve otomatik filtre kurar", async () => {
    const wb = await xlsxOku(await boardToXlsx(ornekBoard(), "Quantro", "tr"));
    const ws = wb.getWorksheet("Görevler")!;
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
  });

  it("gecikmis isi kirmizi gosterir, bitmis kolondakini gostermez", async () => {
    const wb = await xlsxOku(await boardToXlsx(ornekBoard(), "Quantro", "tr"));
    const ws = wb.getWorksheet("Görevler")!;
    // t1: tarihi gecmis, kolon "Yapılacak" -> gecikmis.
    expect(ws.getRow(2).getCell(S.bitis).font?.color?.argb).toBe("FFB91C1C");
    // t3: tarihi gecmis AMA kolon isDone -> gecikmis sayilmaz.
    expect(ws.getRow(4).getCell(S.bitis).font?.color?.argb).toBeUndefined();
  });

  it("ozet sayfasinda kolon/oncelik/kisi dagilimini verir", async () => {
    const wb = await xlsxOku(await boardToXlsx(ornekBoard(), "Quantro", "tr"));
    const ozet = wb.getWorksheet("Özet")!;
    const metin = ozet.getSheetValues().flat().filter(Boolean).join("|");

    expect(metin).toContain("Proje: Quantro");
    expect(metin).toContain("Toplam görev: 3");
    expect(metin).toContain("Kolon bazında");
    expect(metin).toContain("Öncelik bazında");
    expect(metin).toContain("Kişi bazında");
    // Atanmamis kartlar da raporlaniyor (t2).
    expect(metin).toContain("Atanmamış");
  });

  it("dil parametresi basliklari degistirir", async () => {
    const wb = await xlsxOku(await boardToXlsx(ornekBoard(), "Quantro", "en"));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Tasks", "Summary"]);
    const ws = wb.getWorksheet("Tasks")!;
    expect((ws.getRow(1).values as unknown[])[1]).toBe("Column");
    expect(ws.getRow(2).getCell(S.oncelik).value).toBe("Urgent");
  });

  it("bos panoda cokmeden gecerli dosya uretir", async () => {
    const bos: BoardShape = { columns: {}, tasks: {} };
    const wb = await xlsxOku(await boardToXlsx(bos, "Boş Proje", "tr"));
    expect(wb.getWorksheet("Görevler")!.rowCount).toBe(1);
  });
});

describe("boardToCsv", () => {
  it("UTF-8 BOM ile baslar", () => {
    // BOM olmadan Excel dosyayi sistem kod sayfasiyla okuyup turkce
    // karakterleri bozuyordu.
    expect(boardToCsv(ornekBoard()).charCodeAt(0)).toBe(0xfeff);
  });

  it("CRLF satir sonu kullanir ve virgul/tirnak kacislari yapar", () => {
    const csv = boardToCsv(ornekBoard());
    expect(csv).toContain("\r\n");
    expect(csv).toContain('"Virgüllü, ""tırnaklı"" başlık"');
  });

  it("her kart icin tek satir uretir", () => {
    const satirlar = boardToCsv(ornekBoard()).split("\r\n");
    expect(satirlar).toHaveLength(4); // baslik + 3 kart
  });
});

describe("dosyaAdiUret", () => {
  it("proje adi ve tarihten dosya adi uretir", () => {
    const { utf8 } = dosyaAdiUret("Quantro", "xlsx");
    expect(utf8).toMatch(/^Quantro-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("baslik enjeksiyonuna acik karakterleri temizler", () => {
    // Proje adi kullanici girdisi; Content-Disposition'a ham konulamaz.
    const { utf8, ascii } = dosyaAdiUret('kotu"\r\nX-Injected: 1', "xlsx");
    expect(utf8).not.toMatch(/["\r\n]/);
    expect(ascii).not.toMatch(/["\r\n]/);
  });

  it("ascii yedeginde turkce karakter birakmaz", () => {
    const { ascii, utf8 } = dosyaAdiUret("Ödeme Şubesi", "xlsx");
    expect(utf8).toContain("Ödeme");
    expect(ascii).toMatch(/^[\x20-\x7E]+$/);
  });

  it("adi tamamen temizlenen projede yedek isim kullanir", () => {
    const { utf8 } = dosyaAdiUret('///"""', "csv");
    expect(utf8).toMatch(/^board-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
