// Testler .env'deki gercek DATABASE_URL'i kullanir (uzak, PAYLASILAN Supabase).
// Bu yuzden her test kendi verisini benzersiz eklerle olusturur ve sonunda
// temizler; mevcut takim verisine asla dokunmaz.
import "dotenv/config";
import { afterAll } from "vitest";
import { prisma } from "@/lib/prisma";

// Supabase'in pooler'i (Supavisor) session-mode'da sinirli sayida client
// kabul ediyor (pool_size: 15). Baglanti acikta kalirsa (process crash,
// $disconnect cagrilmazsa) o slot suresiz isgal kalir ve "max clients
// reached" hatasi tum ekibi etkiler. Her test dosyasi bitince baglanti
// acikca kapatiliyor.
afterAll(async () => {
  await prisma.$disconnect();
});
