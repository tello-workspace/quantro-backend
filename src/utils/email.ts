import { Resend } from "resend";
import { resolveMx } from "dns/promises";

// RESEND_API_KEY yoksa (lokal gelistirme, CI) e-posta gonderilmez, linki
// konsola yazar - akis kirilmaz, sadece gercek mail gitmez.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM = process.env.RESEND_FROM_EMAIL || "Quantro <onboarding@resend.dev>";

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  if (!resend) {
    console.log(`[EMAIL] RESEND_API_KEY tanimli degil, sifre sifirlama linki (${to}): ${resetUrl}`);
    return;
  }

  await resend.emails.send({
    from: FROM,
    to,
    subject: "Quantro - Şifre Sıfırlama",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Şifre Sıfırlama İsteği</h2>
        <p>Hesabınız için bir şifre sıfırlama talebi aldık. Aşağıdaki bağlantıya tıklayarak yeni bir şifre belirleyebilirsiniz. Bu bağlantı 1 saat geçerlidir.</p>
        <p><a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;">Şifremi Sıfırla</a></p>
        <p style="color:#666;font-size:13px;">Bu isteği siz yapmadıysanız bu e-postayı görmezden gelebilirsiniz; hesabınızda herhangi bir değişiklik yapılmayacaktır.</p>
      </div>
    `,
  });
}

export async function sendVerificationEmail(to: string, verifyUrl: string) {
  if (!resend) {
    console.log(`[EMAIL] RESEND_API_KEY tanimli degil, email dogrulama linki (${to}): ${verifyUrl}`);
    return;
  }

  await resend.emails.send({
    from: FROM,
    to,
    subject: "Quantro - Email Adresini Doğrula",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Hoş Geldin! 👋</h2>
        <p>Quantro'ya kayıt olduğun için teşekkürler. Hesabını aktifleştirmek için email adresini doğrulaman gerekiyor. Aşağıdaki bağlantıya tıkla. Bu bağlantı 24 saat geçerlidir.</p>
        <p><a href="${verifyUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;">Email Adresimi Doğrula</a></p>
        <p style="color:#666;font-size:13px;">Bu kaydı siz yapmadıysanız bu e-postayı görmezden gelebilirsiniz.</p>
      </div>
    `,
  });
}

const MX_LOOKUP_TIMEOUT_MS = 5000;

// Register anindaki ucuz bir on-kontrol: domain gercekten mail alabiliyor mu?
// "asdf@asdf.asdf" gibi var olmayan domainleri format kontrolunden farkli
// olarak eler. DNS sorgusunun kendisi basarisiz OLURSA ya da uzun surerse
// (agin gecici bir sorunu, yavas resolver) kayit ENGELLENMEZ - fail-open,
// sadece loglanir. Timeout sart: cozulmeyen bir domain icin isletim sistemi
// DNS coz.mlemesi onlarca saniye surebilir, bu da register endpoint'ini
// gereksiz yere asabilirdi.
export async function hasValidMxRecord(email: string): Promise<boolean> {
  const domain = email.split("@")[1];
  if (!domain) return false;

  try {
    const records = await Promise.race([
      resolveMx(domain),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error("MX lookup timeout"), { code: "ETIMEOUT" })), MX_LOOKUP_TIMEOUT_MS),
      ),
    ]);
    return records.length > 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    // ENOTFOUND/ENODATA: domain gercekten yok ya da mail almiyor - reddet.
    // Digerleri (ETIMEOUT, ESERVFAIL, ag sorunu vb.): fail-open, kayit engellenmez.
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return false;
    }
    console.warn(`[EMAIL] MX kaydi sorgulanamadi (${domain}), fail-open ile devam ediliyor:`, error);
    return true;
  }
}
