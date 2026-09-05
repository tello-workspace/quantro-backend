import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "http";
import type { AddressInfo } from "net";
import { io as ioClient, type Socket } from "socket.io-client";
import { initializeSocket, broadcastToOrganization, broadcastToProject, broadcastToCard } from "@/server/socket";
import { signToken } from "@/utils/jwt";
import { prisma } from "@/lib/prisma";
import { createWorkspace, createUser, createCard, cleanup } from "@/test/fixtures";
import * as organizationService from "@/services/organization.service";
import * as projectService from "@/services/project.service";

// Regresyon testi: join:org / join:project / join:card handler'lari
// istemciden gelen ID'yi hicbir DB kontrolu yapmadan odaya sokuyordu.
// Kayitli herhangi bir kullanici, uyesi olmadigi bir organizasyonun
// sohbetini/kart hareketlerini bu yolla dinleyebiliyordu. Bu test hem
// acigin bir daha acilmadigini hem de mesru akisin (davet kabulunde
// yeniden baglanmadan odaya girme) kirilmadigini dogrular.
//
// ONEMLI: testler odaya SADECE emit(join:*) yapip beklemekle yetinmiyor —
// katilim denemesinden SONRA o odaya gercek bir yayin (broadcastTo*)
// yapip alici tarafta gozlemliyor. Aksi halde "hicbir sey gelmedi" sonucu,
// yetkilendirmenin isledigini degil, kimsenin bir sey yayinlamadigini
// gosterir (bos test).
describe("socket oda yetkilendirmesi", () => {
  let ws: Awaited<ReturnType<typeof createWorkspace>>;
  let serverUrl: string;
  let httpServer: ReturnType<typeof createServer>;

  beforeAll(async () => {
    ws = await createWorkspace();

    httpServer = createServer();
    initializeSocket(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;
    serverUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await cleanup({
      orgIds: [ws.org.id],
      userIds: [ws.admin.id, ws.member.id, ws.outsider.id],
    });
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function connect(userId: string, email: string): Promise<Socket> {
    const token = signToken({ userId, email });
    const socket = ioClient(serverUrl, { auth: { token }, transports: ["websocket"] });
    return new Promise((resolve, reject) => {
      socket.on("authenticated", () => resolve(socket));
      socket.on("connect_error", reject);
      setTimeout(() => reject(new Error("socket baglanamadi")), 5000);
    });
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Oda katilimi asenkron ve DB'ye bagli (uzak Supabase'te org icin ~1 sorgu,
  // kart icin 3 sorgu). Eskiden buradaki adimlar sabit 300/400ms uyuyup
  // "herhalde katildik" varsayiyordu; yuk altinda sorgu uykudan uzun surunce
  // yayin kaciriliyor ve test, urunde hicbir sey bozulmamisken kirmizi
  // yaniyordu. Handler artik ack donduruyor - katilimin gercekten bittigini
  // (ve kabul mu red mi edildigini) bekliyoruz, tahmin etmiyoruz.
  function join(socket: Socket, olay: "join:org" | "join:project" | "join:card", id: string) {
    return new Promise<{ ok: boolean; reason?: string }>((resolve, reject) => {
      const zamanlayici = setTimeout(() => reject(new Error(`${olay} onayi gelmedi`)), 10000);
      socket.emit(olay, id, (sonuc: { ok: boolean; reason?: string }) => {
        clearTimeout(zamanlayici);
        resolve(sonuc);
      });
    });
  }

  function collectEvents(socket: Socket): string[] {
    const events: string[] = [];
    socket.onAny((event) => {
      if (["authenticated", "connect", "presence:online", "presence:offline"].includes(event)) return;
      events.push(event);
    });
    return events;
  }

  // conflict:detected icin olay ADI yetmiyor: hangi dosya icin geldigi de
  // dogrulanmali, yoksa "bir olay geldi" testi cakismanin dogru kapsamda
  // hesaplandigini gostermez.
  function collectConflicts(socket: Socket): Array<{ filePath?: string }> {
    const conflicts: Array<{ filePath?: string }> = [];
    socket.on("conflict:detected", (payload: { filePath?: string }) => conflicts.push(payload));
    return conflicts;
  }

  // presence:file'in ack'i yok; pozitif senaryoyu sabit uykuyla beklemek
  // yuk altinda yanlis kirmizi verir. Beklenen olayin kendisini bekliyoruz.
  function waitForEvent(socket: Socket, event: string, ms = 10000) {
    return new Promise<void>((resolve, reject) => {
      const zamanlayici = setTimeout(() => reject(new Error(`${event} gelmedi`)), ms);
      socket.once(event, () => {
        clearTimeout(zamanlayici);
        resolve();
      });
    });
  }

  it("uyesi olmadigi organizasyonun/projenin/kartin odasina giremez ve yayin alamaz", async () => {
    const card = await createCard(ws.todo.id, ws.admin.id, "Gizli kart");
    const outsiderSocket = await connect(ws.outsider.id, ws.outsider.email);
    const received = collectEvents(outsiderSocket);

    // Uc katilim da ACIKCA reddedilmeli - "cevap gelmedi" ile "reddedildi"
    // ayni sey degil, ack bunu ayirt ediyor.
    expect(await join(outsiderSocket, "join:org", ws.org.id)).toEqual({ ok: false, reason: "FORBIDDEN" });
    expect(await join(outsiderSocket, "join:project", ws.project.id)).toEqual({ ok: false, reason: "FORBIDDEN" });
    expect(await join(outsiderSocket, "join:card", card.id)).toEqual({ ok: false, reason: "FORBIDDEN" });

    // Odaya girme denemesinden SONRA gercek yayinlar yap
    broadcastToOrganization(ws.org.id, "chat:message" as never, { text: "gizli org mesaji" } as never);
    broadcastToProject(ws.project.id, "card:updated" as never, { id: card.id } as never);
    broadcastToCard(card.id, "comment:added" as never, { text: "gizli yorum" } as never);
    await sleep(400);

    expect(received).toEqual([]);

    outsiderSocket.close();
  });

  it("gercek uye ayni yayinlari alir (duzeltme yanlislikla mesru erisimi kapatmamis)", async () => {
    const card = await createCard(ws.todo.id, ws.admin.id, "Herkese acik kart");
    const memberSocket = await connect(ws.member.id, ws.member.email);
    const received = collectEvents(memberSocket);

    expect(await join(memberSocket, "join:org", ws.org.id)).toEqual({ ok: true });
    expect(await join(memberSocket, "join:project", ws.project.id)).toEqual({ ok: true });
    expect(await join(memberSocket, "join:card", card.id)).toEqual({ ok: true });

    broadcastToOrganization(ws.org.id, "chat:message" as never, { text: "org mesaji" } as never);
    broadcastToProject(ws.project.id, "card:updated" as never, { id: card.id } as never);
    broadcastToCard(card.id, "comment:added" as never, { text: "yorum" } as never);
    await sleep(400);

    expect(received).toEqual(
      expect.arrayContaining(["chat:message", "card:updated", "comment:added"]),
    );

    memberSocket.close();
  });

  it("davet kabulunden sonra YENIDEN BAGLANMADAN odaya girip yayin alabilir", async () => {
    // Gercek urun akisi: kullanici socket'e baglaniyor, SONRA davet kabul
    // ediyor, sayfa yenilenmeden odaya girmesi gerekiyor.
    const freshUser = await createUser("Fresh Invitee");
    const socket = await connect(freshUser.id, freshUser.email);
    const received = collectEvents(socket);

    // Henuz uye degil -> reddedilmeli, yayin da alinmamali
    expect(await join(socket, "join:org", ws.org.id)).toEqual({ ok: false, reason: "FORBIDDEN" });
    broadcastToOrganization(ws.org.id, "chat:message" as never, { text: "uye olmadan once" } as never);
    await sleep(300);
    expect(received).toEqual([]);

    // Davet kabul edilmis gibi uyelik olusturuluyor
    await prisma.organizationMember.create({
      data: { organizationId: ws.org.id, userId: freshUser.id, role: "MEMBER" },
    });

    // Ayni socket, yeniden baglanmadan tekrar join dener -> artik kabul edilmeli
    expect(await join(socket, "join:org", ws.org.id)).toEqual({ ok: true });
    broadcastToOrganization(ws.org.id, "chat:message" as never, { text: "uye olduktan sonra" } as never);
    await sleep(300);

    expect(received).toEqual(["chat:message"]);

    socket.close();
    await cleanup({ userIds: [freshUser.id] });
  });

  // ─── Yetki KAYBININ canli baglantiya yansimasi ────────────────────────
  // Yukaridaki testler yalnizca "girisi" kapsiyordu: odaya girerken DB
  // kontrolu var mi? Simetrik ters senaryo (baglantı ACIKKEN uyeligin
  // kaybedilmesi) hic test edilmiyordu ve tam da bu yuzden acik uzun sure
  // fark edilmedi: oda uyeligi yalnizca handshake aninda hesaplandigi icin
  // cikarilan uye REST'te 403 alirken canli yayinlari almaya devam ediyordu.
  // Asagidaki iki test tahliyenin (evictFromOrganization / revalidateProjectRoom)
  // gercekten islediğini, yayin gozlemleyerek dogrular.

  it("organizasyondan cikarilan uyenin ACIK socket'i org/proje/kart odalarindan atilir", async () => {
    const uye = await createUser("Cikarilacak Uye");
    await prisma.organizationMember.create({
      data: { organizationId: ws.org.id, userId: uye.id, role: "MEMBER" },
    });
    const card = await createCard(ws.todo.id, ws.admin.id, "Tahliye karti");

    const socket = await connect(uye.id, uye.email);
    const received = collectEvents(socket);

    expect(await join(socket, "join:org", ws.org.id)).toEqual({ ok: true });
    expect(await join(socket, "join:project", ws.project.id)).toEqual({ ok: true });
    expect(await join(socket, "join:card", card.id)).toEqual({ ok: true });

    // Gercek urun yolu kullaniliyor (servisin tahliyeyi cagirmayi unutmasi da
    // bu testte yakalansin diye), dogrudan evictFromOrganization degil.
    await organizationService.removeMember(ws.org.id, uye.id, ws.admin.id);

    // Cikarma ANINDA giden bildirim/uye-cikarildi olaylari mesru; olculmek
    // istenen SONRASINDAKI yayinlar, o yuzden tampon sifirlaniyor.
    await sleep(600);
    received.length = 0;

    broadcastToOrganization(ws.org.id, "chat:message" as never, { text: "cikarildiktan sonra" } as never);
    broadcastToProject(ws.project.id, "card:updated" as never, { id: card.id } as never);
    broadcastToCard(card.id, "comment:added" as never, { text: "gizli yorum" } as never);
    await sleep(400);

    expect(received).toEqual([]);
    // Elle yeniden girme denemesi de reddedilmeli - aksi halde tahliye sadece
    // bir sonraki emit'e kadar dayanirdi.
    expect(await join(socket, "join:org", ws.org.id)).toEqual({ ok: false, reason: "FORBIDDEN" });

    socket.close();
    await cleanup({ userIds: [uye.id] });
  });

  it("proje PRIVATE'a cevrilince erisimi kalkan uye proje/kart odalarindan atilir", async () => {
    const uye = await createUser("Gorunurluk Kurbani");
    await prisma.organizationMember.create({
      data: { organizationId: ws.org.id, userId: uye.id, role: "MEMBER" },
    });
    const card = await createCard(ws.todo.id, ws.admin.id, "Gorunurluk karti");

    const socket = await connect(uye.id, uye.email);
    const received = collectEvents(socket);

    expect(await join(socket, "join:project", ws.project.id)).toEqual({ ok: true });
    expect(await join(socket, "join:card", card.id)).toEqual({ ok: true });

    // ORG -> PRIVATE: uye ProjectMember degil, dolayisiyla erisimi kalkiyor.
    await projectService.updateProjectVisibility(ws.project.id, "PRIVATE", ws.admin.id);

    // Gorunurluk degisiminin KENDI PROJECT_UPDATED yayini (org odasina gidiyor,
    // uye hala org uyesi) olculmek istenen sey degil.
    await sleep(600);
    received.length = 0;

    broadcastToProject(ws.project.id, "card:updated" as never, { id: card.id } as never);
    broadcastToCard(card.id, "comment:added" as never, { text: "gizli yorum" } as never);
    await sleep(400);

    expect(received).toEqual([]);
    expect(await join(socket, "join:project", ws.project.id)).toEqual({ ok: false, reason: "FORBIDDEN" });

    // Ayni workspace'i paylasan diger testler etkilenmesin.
    await prisma.project.update({ where: { id: ws.project.id }, data: { visibility: "ORG" } });

    socket.close();
    await cleanup({ userIds: [uye.id] });
  });

  it("presence:file cakismasi organizasyon sinirini asmaz", async () => {
    // presence:file icin hic test yoktu; cakisma haritasi bir donem dosya
    // yoluyla anahtarlaniyordu, yani ayni yolda (ornegin "src/index.ts")
    // calisan iki AYRI kiracinin kart basliklari birbirine sizabiliyordu.
    // Anahtar artik organizasyona gore kapsanmis durumda.
    //
    // Negatif tarafin bos gecmedigini kanitlamak icin AYNI org'daki gercek
    // cakisma da ayni akista dogrulaniyor: mekanizma calisiyor, sadece
    // organizasyon sinirini asmiyor.
    const ws2 = await createWorkspace();
    const kartA = await createCard(ws.todo.id, ws.admin.id, "A karti");
    const kartB = await createCard(ws.todo.id, ws.admin.id, "B karti");
    const yabanciKart = await createCard(ws2.todo.id, ws2.admin.id, "Yabanci org karti");
    const YOL = "src/paylasilan-dosya.ts";

    const adminSocket = await connect(ws.admin.id, ws.admin.email);
    const memberSocket = await connect(ws.member.id, ws.member.email);
    const yabanciSocket = await connect(ws2.admin.id, ws2.admin.email);

    expect(await join(adminSocket, "join:project", ws.project.id)).toEqual({ ok: true });
    expect(await join(memberSocket, "join:project", ws.project.id)).toEqual({ ok: true });
    expect(await join(yabanciSocket, "join:project", ws2.project.id)).toEqual({ ok: true });

    const adminCakismalari = collectConflicts(adminSocket);
    const yabanciCakismalari = collectConflicts(yabanciSocket);

    // 1) Org A'dan admin dosyayi acar (henuz kimse yok, cakisma beklenmiyor).
    adminSocket.emit("presence:file", { cardId: kartA.id, filePath: YOL });
    await sleep(1500);

    // 2) Org B'den biri AYNI yolu acar - farkli kiraci, cakisma sayilmamali.
    yabanciSocket.emit("presence:file", { cardId: yabanciKart.id, filePath: YOL });
    await sleep(1500);
    expect(yabanciCakismalari).toEqual([]);
    expect(adminCakismalari).toEqual([]);

    // 3) Org A'dan ikinci kisi FARKLI bir kartla ayni yolu acar - iste bu
    //    gercek cakisma; mekanizmanin calistigini kanitlar.
    const cakismaBekle = waitForEvent(adminSocket, "conflict:detected");
    memberSocket.emit("presence:file", { cardId: kartB.id, filePath: YOL });
    await cakismaBekle;
    await sleep(500);

    expect(adminCakismalari.length).toBeGreaterThan(0);
    expect(adminCakismalari[0].filePath).toBe(YOL);
    // Yabanci org, kendisiyle ayni yolda ucusan bu cakismadan haberdar olmamali.
    expect(yabanciCakismalari).toEqual([]);

    adminSocket.close();
    memberSocket.close();
    yabanciSocket.close();
    await cleanup({
      orgIds: [ws2.org.id],
      userIds: [ws2.admin.id, ws2.member.id, ws2.outsider.id],
    });
  });
});
