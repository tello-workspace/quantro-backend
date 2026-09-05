// Sentry init + .env, diger her seyden once yuklenmeli: bu dosyanin import
// ettigi moduller (socket -> jwt/prisma) Next'in kendi env yuklemesinden
// once calisiyor, Sentry'nin otomatik enstrumantasyonu da digerlerinden once.
import "./src/instrument";
import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { initializeSocket } from "@/server/socket";

// Son savunma hatti: surec genelinde yakalanmamis hatalar.
//
// Node 15+ varsayilaninda yakalanmamis bir promise reddi TUM SURECI oldurur.
// Bu sunucu yalnizca HTTP degil, ayni surecte Socket.IO baglantilarini ve
// node-cron zamanlayicilarini da tasiyor - yani tek bir arka plan promise'inin
// (bir bildirim yayini, bir webhook denemesi, bir hata kaydi) sessizce
// reddetmesi, o anda bagli olan HERKESIN canli baglantisini birlikte
// dusuruyordu. Cagri yerlerinde tek tek .catch koymak bu sinifi kapatmaya
// yetmez; burada aglayip logluyoruz ve ayakta kaliyoruz.
//
// uncaughtException bilerek AYRI tutuldu: orada surec gercekten tutarsiz bir
// duruma dusmus olabilir, o yuzden logladiktan sonra duzenli cikis yapip
// surec yoneticisinin (Render) temiz bir ornek baslatmasina birakiyoruz.
process.on("unhandledRejection", (sebep) => {
  console.error("[surec] Yakalanmamis promise reddi (surec ayakta tutuluyor):", sebep);
});

process.on("uncaughtException", (hata) => {
  console.error("[surec] Yakalanmamis istisna - surec duzenli olarak kapatiliyor:", hata);
  process.exit(1);
});

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "localhost";
// Varsayilan 4000: .env.example, frontend ve VS Code eklentisi de bu portu
// bekliyor. PORT tanimsizken 3001'e dusmek, tum istemcileri sessizce
// baglanamaz hale getiriyordu.
const port = parseInt(process.env.PORT || "4000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer(async (req, res) => {
    try {
      // Gercek TCP kaynak adresini rate limit'e tasiyoruz. Istemcinin ayni
      // basligi gondermesi ihtimaline karsi degeri EZIYORUZ; boylece
      // rateLimit.ts, X-Forwarded-For beklenen bicimde gelmediginde
      // sahtelenemeyen bir kova anahtarina dusebiliyor (aksi halde tum
      // istekler tek "unknown" kovasini paylasiyordu).
      req.headers["x-socket-remote-address"] = req.socket.remoteAddress ?? "";

      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error occurred handling", req.url, err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  });

  // Initialize Socket.io
  initializeSocket(httpServer);

  httpServer.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
