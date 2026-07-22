// Socket.io sunucusu - gercek zamanli yayin (bildirim, kart/kolon/proje/org olaylari)
import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { verifyToken } from "@/utils/jwt";
import { prisma } from "@/lib/prisma";

export enum SocketEvents {
  AUTHENTICATED = "authenticated",

  // Bildirim
  NOTIFICATION_NEW = "notification:new",
  NOTIFICATION_READ = "notification:read",
  NOTIFICATION_ALL_READ = "notification:all_read",

  // Organizasyon
  ORG_MEMBER_ADDED = "org:member_added",
  ORG_MEMBER_REMOVED = "org:member_removed",
  ORG_MEMBER_ROLE_CHANGED = "org:member_role_changed",

  // Proje
  PROJECT_CREATED = "project:created",
  PROJECT_UPDATED = "project:updated",
  PROJECT_DELETED = "project:deleted",

  // Kart
  CARD_CREATED = "card:created",
  CARD_UPDATED = "card:updated",
  CARD_MOVED = "card:moved",
  CARD_DELETED = "card:deleted",
  CARD_ASSIGNED = "card:assigned",

  // Kolon
  COLUMN_CREATED = "column:created",
  COLUMN_UPDATED = "column:updated",
  COLUMN_DELETED = "column:deleted",

  // Yorum
  COMMENT_ADDED = "comment:added",
  COMMENT_UPDATED = "comment:updated",
  COMMENT_DELETED = "comment:deleted",

  // Bağımlılık
  DEPENDENCY_ADDED = "dependency:added",
  DEPENDENCY_REMOVED = "dependency:removed",
}

export interface AuthenticatedSocket extends Socket {
  userId?: string;
  userName?: string;
  organizations?: string[];
  projects?: string[];
}

// server.ts (require ile) ve Next'in API route'lari (Next'in kendi bundler'i
// uzerinden import ile) bu dosyayi IKI AYRI modul kopyasi olarak yukluyor.
// globalThis ile tum surec icinde TEK bir io referansi garantileniyor.
const globalForSocket = globalThis as unknown as { __io?: SocketIOServer };

export function getIO(): SocketIOServer | null {
  return globalForSocket.__io ?? null;
}

export function initializeSocket(httpServer: HttpServer): SocketIOServer {
  if (globalForSocket.__io) return globalForSocket.__io;

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true,
    },
  });
  globalForSocket.__io = io;

  // Baglanti kurulurken JWT dogrulama - gecersiz/eksik token'la baglanti reddedilir
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) return next(new Error("Authentication required"));

      const payload = verifyToken(token as string);
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { id: true, name: true },
      });
      if (!user) return next(new Error("User not found"));

      socket.userId = user.id;
      socket.userName = user.name;

      // Oda katilimi icin kullanicinin organizasyon ve proje uyeliklerini cek
      const memberships = await prisma.organizationMember.findMany({
        where: { userId: user.id },
        select: { organizationId: true },
      });
      socket.organizations = memberships.map((m) => m.organizationId);

      const projects = await prisma.project.findMany({
        where: { organization: { members: { some: { userId: user.id } } } },
        select: { id: true },
      });
      socket.projects = projects.map((p) => p.id);

      next();
    } catch (error) {
      console.error("[SOCKET] Auth error:", error);
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket: AuthenticatedSocket) => {
    socket.join(`user:${socket.userId}`);
    socket.organizations?.forEach((orgId) => socket.join(`org:${orgId}`));
    socket.projects?.forEach((projectId) => socket.join(`project:${projectId}`));

    socket.emit(SocketEvents.AUTHENTICATED, { id: socket.userId, name: socket.userName });

    // Proje bazli oda yonetimi - kullanici yeni bir org/projeye katildiginda
    // (davet kabul, proje olusturma) sayfa yenilemeden ilgili odaya girebilsin
    socket.on("join:project", (projectId: string) => socket.join(`project:${projectId}`));
    socket.on("leave:project", (projectId: string) => socket.leave(`project:${projectId}`));
    socket.on("join:org", (organizationId: string) => socket.join(`org:${organizationId}`));
  });

  console.log("[SOCKET] Socket.io sunucusu baslatildi");
  return io;
}

export function broadcastToUser(userId: string, event: SocketEvents, data: unknown) {
  const io = getIO();
  if (!io) {
    console.log(`[SOCKET] io yok, ${event} -> user:${userId} yayinlanamadi`);
    return;
  }
  io.to(`user:${userId}`).emit(event, data);
}

export function broadcastToOrganization(organizationId: string, event: SocketEvents, data: unknown) {
  const io = getIO();
  if (!io) return;
  io.to(`org:${organizationId}`).emit(event, data);
}

export function broadcastToProject(projectId: string, event: SocketEvents, data: unknown) {
  const io = getIO();
  if (!io) return;
  io.to(`project:${projectId}`).emit(event, data);
}
