// RFC 4180 CSV okuyucu: tirnakli alanlar, ic ice virgul/satir sonu, "" kacisli
// tirnak. export.service.ts'teki yazici (boardToCsv) ile ayni standarda
// sadik - Jira'nin ürettigi CSV'de Description gibi alanlar coklu satir ve
// virgul icerebiliyor, basit split(',') bunlari kirar.
export function parseCsv(text: string): string[][] {
  // Bastaki UTF-8 BOM'u at - Excel/Jira export'lari genelde BOM'lu yazar.
  const temiz = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const satirlar: string[][] = [];
  let satir: string[] = [];
  let alan = "";
  let tirnakIcinde = false;
  let i = 0;
  const n = temiz.length;

  while (i < n) {
    const ch = temiz[i];

    if (tirnakIcinde) {
      if (ch === '"') {
        if (temiz[i + 1] === '"') {
          alan += '"';
          i += 2;
          continue;
        }
        tirnakIcinde = false;
        i++;
        continue;
      }
      alan += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      tirnakIcinde = true;
      i++;
      continue;
    }
    if (ch === ",") {
      satir.push(alan);
      alan = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      satir.push(alan);
      satirlar.push(satir);
      satir = [];
      alan = "";
      i++;
      continue;
    }
    alan += ch;
    i++;
  }

  if (alan.length > 0 || satir.length > 0) {
    satir.push(alan);
    satirlar.push(satir);
  }

  // Sondaki tamamen bos satirlari at (dosya sonu bos satirla bitiyorsa).
  return satirlar.filter((s) => !(s.length === 1 && s[0] === ""));
}
