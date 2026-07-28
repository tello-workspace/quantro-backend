import { Resend } from "resend";

// RESEND_API_KEY yoksa (lokal gelistirme, CI) e-posta gonderilmez, linki
// konsola yazar - akis kirilmaz, sadece gercek mail gitmez.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM = process.env.RESEND_FROM_EMAIL || "Tello <onboarding@resend.dev>";

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  if (!resend) {
    console.log(`[EMAIL] RESEND_API_KEY tanimli degil, sifre sifirlama linki (${to}): ${resetUrl}`);
    return;
  }

  await resend.emails.send({
    from: FROM,
    to,
    subject: "Tello - Şifre Sıfırlama",
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
