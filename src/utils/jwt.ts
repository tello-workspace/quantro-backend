import jwt from "jsonwebtoken";

const EXPIRES_IN = "7d";

export type JwtPayload = {
  userId: string;
  email: string;
};

// Secret modul yuklenirken degil, KULLANILIRKEN okunur.
//
// server.ts en ustte @/server/socket'i import ediyor, o da bu modulu cekiyor.
// Bu zincir Next'in .env'i yuklemesinden once calistigi icin modul seviyesinde
// okunan sabit, socket tarafinda yedek degere dusuyordu. Sonucta REST tarafi
// gercek secret ile imzalarken socket tarafi "degistirin" ile dogruluyor,
// hicbir gercek istemci soket'e baglanamiyordu (realtime tamamen olu).
//
// Yedek deger de bilerek kaldirildi: repoda yazili bir varsayilan ile token
// dogrulamak, o degeri bilen herkesin gecerli token uretebilmesi demektir.
function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET tanimli degil. .env dosyasina JWT_SECRET ekleyin.");
  }
  return secret;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getSecret()) as JwtPayload;
}
