import crypto from "crypto";

// Kullanicilarin kendi AI API anahtarlarini (bkz. User.aiApiKey) veritabaninda
// duz metin yerine sifreli saklamak icin. AES-256-GCM: her sifrelemede rastgele
// IV uretilir, authTag ile bütünlük dogrulanir (ciphertext'in tek bir biti bile
// degistirilirse cozme basarisiz olur).
//
// Secret modul yuklenirken degil, KULLANILIRKEN okunur (bkz. jwt.ts'teki ayni
// desen) - Next'in .env'i yuklemesinden once bu modulun cekilme ihtimaline karsi.
const ALGORITHM = "aes-256-gcm";
const SALT = "tello-ai-key-v1"; // gizli degil, sadece key derivation'i sabitliyor

function getKey(): Buffer {
  const secret = process.env.AI_KEY_SECRET;
  if (!secret) {
    throw new Error("AI_KEY_SECRET tanimli degil. .env dosyasina AI_KEY_SECRET ekleyin.");
  }
  return crypto.scryptSync(secret, SALT, 32);
}

// Format: "iv:authTag:ciphertext" (hepsi hex) - tek string olarak DB'ye yazilir
export function encryptSecret(plainText: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

// Cozemezse (yanlis/degismis AI_KEY_SECRET, bozuk veri) null doner - cagiran
// taraf bunu "kayitli anahtar yok" gibi ele alip global saglayiciya dusmeli,
// tum AI ozelligini kirmamak icin.
export function decryptSecret(stored: string): string | null {
  try {
    const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
    if (!ivHex || !authTagHex || !ciphertextHex) return null;

    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, "hex")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch (error) {
    console.error("[crypto] AI anahtari cozulemedi:", error);
    return null;
  }
}
