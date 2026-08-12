import dns from "node:dns/promises";
import net from "node:net";

// SSRF korumasi: kullanicinin verdigi webhook URL'sine SUNUCUDAN istek
// atiliyor - bu, dogrulanmazsa saldirganin sunucuyu kendi ic agina/metadata
// servisine (169.254.169.254 gibi) istek atmaya zorlamasinin klasik yolu.
// Kontrol IKI asamali: (1) URL olusturulurken/kaydedilirken bir on-kontrol,
// (2) HER GONDERIMDEN once TEKRAR (DNS rebinding - kayit anindaki IP ile
// gonderim anindaki IP farkli olabilir, DNS TTL süresi dolabilir).

const OZEL_IPV4_ARALIKLARI: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local - bulut metadata servisleri burada (AWS/GCP/Azure)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
];

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, oktet) => (acc << 8) + parseInt(oktet, 10), 0) >>> 0;
}

function ipv4Ozel(ip: string): boolean {
  const deger = ipv4ToInt(ip);
  return OZEL_IPV4_ARALIKLARI.some(([taban, prefix]) => {
    const maske = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (deger & maske) === (ipv4ToInt(taban) & maske);
  });
}

function ipv6Ozel(ip: string): boolean {
  const kucuk = ip.toLowerCase();
  if (kucuk === "::1" || kucuk === "::") return true;
  // fc00::/7 (unique local) ve fe80::/10 (link-local)
  if (kucuk.startsWith("fc") || kucuk.startsWith("fd") || kucuk.startsWith("fe8") || kucuk.startsWith("fe9") || kucuk.startsWith("fea") || kucuk.startsWith("feb")) {
    return true;
  }
  // IPv4-mapped (::ffff:a.b.c.d) - icindeki IPv4'u kontrol et
  const eslesme = kucuk.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (eslesme) return ipv4Ozel(eslesme[1]);
  return false;
}

function ipOzelMi(ip: string): boolean {
  return net.isIP(ip) === 4 ? ipv4Ozel(ip) : net.isIP(ip) === 6 ? ipv6Ozel(ip) : true; // taniyamadigimiz bir sey guvenli varsayilan degil
}

export class WebhookGuvenlikHatasi extends Error {}

// URL'i hem sozdizimi hem de cozdugu IP'ler acisindan dogrular. Redirect
// TAKIP ETMEZ (cagiran taraf fetch'te redirect:'manual' kullanmali) - bir
// yonlendirme kontrolsuz bir hedefe cikabilir.
export async function guvenliWebhookUrlDogrula(urlStr: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new WebhookGuvenlikHatasi("Geçersiz URL");
  }

  if (url.protocol !== "https:") {
    throw new WebhookGuvenlikHatasi("Sadece https:// webhook URL'leri kabul edilir");
  }

  const hostname = url.hostname;
  if (hostname === "localhost") {
    throw new WebhookGuvenlikHatasi("localhost hedefi kabul edilmiyor");
  }

  // Hostname zaten bir IP literal ise dogrudan kontrol et.
  if (net.isIP(hostname)) {
    if (ipOzelMi(hostname)) {
      throw new WebhookGuvenlikHatasi("Özel/yerel IP aralığına webhook gönderilemez");
    }
    return url;
  }

  // Degilse COZ ve TUM sonuclari kontrol et (bir domain hem genel hem ozel
  // bir IP'ye cozulebilir - DNS rebinding'in kendisi budur).
  let adresler: { address: string }[];
  try {
    adresler = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new WebhookGuvenlikHatasi("Hostname çözümlenemedi");
  }

  if (adresler.length === 0 || adresler.some((a) => ipOzelMi(a.address))) {
    throw new WebhookGuvenlikHatasi("Hostname özel/yerel bir IP'ye çözülüyor");
  }

  return url;
}
