import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "http";
import type { AddressInfo } from "net";
import { io as ioClient, type Socket } from "socket.io-client";
import { initializeSocket, broadcastToOrganization, broadcastToProject, broadcastToCard } from "@/server/socket";
import { signToken } from "@/utils/jwt";
import { prisma } from "@/lib/prisma";
import { createWorkspace, createUser, createCard, cleanup } from "@/test/fixtures";

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

  function collectEvents(socket: Socket): string[] {
    const events: string[] = [];
    socket.onAny((event) => {
      if (["authenticated", "connect", "presence:online", "presence:offline"].includes(event)) return;
      events.push(event);
    });
    return events;
  }

  it("uyesi olmadigi organizasyonun/projenin/kartin odasina giremez ve yayin alamaz", async () => {
    const card = await createCard(ws.todo.id, ws.admin.id, "Gizli kart");
    const outsiderSocket = await connect(ws.outsider.id, ws.outsider.email);
    const received = collectEvents(outsiderSocket);

    outsiderSocket.emit("join:org", ws.org.id);
    outsiderSocket.emit("join:project", ws.project.id);
    outsiderSocket.emit("join:card", card.id);
    await sleep(400);

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

    memberSocket.emit("join:org", ws.org.id);
    memberSocket.emit("join:project", ws.project.id);
    memberSocket.emit("join:card", card.id);
    await sleep(400);

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
    socket.emit("join:org", ws.org.id);
    await sleep(300);
    broadcastToOrganization(ws.org.id, "chat:message" as never, { text: "uye olmadan once" } as never);
    await sleep(300);
    expect(received).toEqual([]);

    // Davet kabul edilmis gibi uyelik olusturuluyor
    await prisma.organizationMember.create({
      data: { organizationId: ws.org.id, userId: freshUser.id, role: "MEMBER" },
    });

    // Ayni socket, yeniden baglanmadan tekrar join dener -> artik kabul edilmeli
    socket.emit("join:org", ws.org.id);
    await sleep(300);
    broadcastToOrganization(ws.org.id, "chat:message" as never, { text: "uye olduktan sonra" } as never);
    await sleep(300);

    expect(received).toEqual(["chat:message"]);

    socket.close();
    await cleanup({ userIds: [freshUser.id] });
  });
});
