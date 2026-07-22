// Socket.io server setup for real-time notifications
import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { verifyToken } from "@/utils/jwt";
import { prisma } from "@/lib/prisma";

export interface ServerSocketEvents {
  // Connection events
  connect: () => void;
  disconnect: (reason: string) => void;
  connect_error: (error: Error) => void;

  // Auth
  authenticate: (token: string) => void;
  authenticated: (user: { id: string; name: string; email: string }) => void;
  auth_error: (message: string) => void;

  // Notifications
  [SocketEvents.NOTIFICATION_NEW]: (notification: NotificationPayload) => void;
  [SocketEvents.NOTIFICATION_READ]: (data: { notificationId: string; read: boolean }) => void;
  [SocketEvents.NOTIFICATION_ALL_READ]: (data: { success: boolean }) => void;

  // Organization events
  [SocketEvents.ORG_MEMBER_ADDED]: (data: OrgEventPayload) => void;
  [SocketEvents.ORG_MEMBER_REMOVED]: (data: OrgEventPayload) => void;
  [SocketEvents.ORG_MEMBER_ROLE_CHANGED]: (data: OrgEventPayload) => void;

  // Project/Board events
  [SocketEvents.PROJECT_CREATED]: (project: ProjectPayload) => void;
  [SocketEvents.PROJECT_UPDATED]: (project: ProjectPayload) => void;
  [SocketEvents.PROJECT_DELETED]: (projectId: string) => void;

  // Card events
  [SocketEvents.CARD_CREATED]: (card: CardPayload) => void;
  [SocketEvents.CARD_UPDATED]: (card: CardPayload) => void;
  [SocketEvents.CARD_MOVED]: (data: CardMovedPayload) => void;
  [SocketEvents.CARD_DELETED]: (cardId: string) => void;
  [SocketEvents.CARD_ASSIGNED]: (data: CardAssignedPayload) => void;

  // Column events
  [SocketEvents.COLUMN_CREATED]: (column: ColumnPayload) => void;
  [SocketEvents.COLUMN_UPDATED]: (column: ColumnPayload) => void;
  [SocketEvents.COLUMN_DELETED]: (columnId: string) => void;
  [SocketEvents.COLUMN_WIP_EXCEEDED]: (data: { columnId: string; count: number; limit: number }) => void;

  // Comment events
  [SocketEvents.COMMENT_ADDED]: (comment: CommentPayload) => void;
  [SocketEvents.COMMENT_UPDATED]: (comment: CommentPayload) => void;
  [SocketEvents.COMMENT_DELETED]: (commentId: string) => void;

  // Activity events
  [SocketEvents.ACTIVITY_NEW]: (activity: ActivityPayload) => void;

  // Stale/Insight events
  [SocketEvents.STALE_CARD_DETECTED]: (data: StaleCardPayload) => void;
  [SocketEvents.WORKLOAD_IMBALANCE]: (data: WorkloadPayload) => void;
  [SocketEvents.DEADLINE_RISK]: (data: DeadlineRiskPayload) => void;

  // Presence
  [SocketEvents.USER_ONLINE]: (userId: string) => void;
  [SocketEvents.USER_OFFLINE]: (userId: string) => void;
  [SocketEvents.USER_TYPING]: (data: TypingPayload) => void;
}

export enum SocketEvents {
  // Auth
  AUTHENTICATE = "authenticate",
  AUTHENTICATED = "authenticated",
  AUTH_ERROR = "auth_error",

  // Notifications
  NOTIFICATION_NEW = "notification:new",
  NOTIFICATION_READ = "notification:read",
  NOTIFICATION_ALL_READ = "notification:all_read",

  // Organization
  ORG_MEMBER_ADDED = "org:member_added",
  ORG_MEMBER_REMOVED = "org:member_removed",
  ORG_MEMBER_ROLE_CHANGED = "org:member_role_changed",

  // Project
  PROJECT_CREATED = "project:created",
  PROJECT_UPDATED = "project:updated",
  PROJECT_DELETED = "project:deleted",

  // Card
  CARD_CREATED = "card:created",
  CARD_UPDATED = "card:updated",
  CARD_MOVED = "card:moved",
  CARD_DELETED = "card:deleted",
  CARD_ASSIGNED = "card:assigned",

  // Column
  COLUMN_CREATED = "column:created",
  COLUMN_UPDATED = "column:updated",
  COLUMN_DELETED = "column:deleted",
  COLUMN_WIP_EXCEEDED = "column:wip_exceeded",

  // Comment
  COMMENT_ADDED = "comment:added",
  COMMENT_UPDATED = "comment:updated",
  COMMENT_DELETED = "comment:deleted",

  // Activity
  ACTIVITY_NEW = "activity:new",

  // Insights/Proactive
  STALE_CARD_DETECTED = "insight:stale_card",
  WORKLOAD_IMBALANCE = "insight:workload_imbalance",
  DEADLINE_RISK = "insight:deadline_risk",

  // Presence
  USER_ONLINE = "presence:online",
  USER_OFFLINE = "presence:offline",
  USER_TYPING = "presence:typing",
}

// Payload types
export interface NotificationPayload {
  id: string;
  userId: string;
  type: string;
  message: string;
  cardId?: string;
  card?: { id: string; title: string };
  invitationId?: string;
  invitation?: { id: string; status: string };
  read: boolean;
  createdAt: string;
}

export interface OrgEventPayload {
  organizationId: string;
  userId: string;
  userName: string;
  role?: string;
  type?: string;
  message?: string;
  excludeUserId?: string;
}

export interface ProjectPayload {
  id: string;
  name: string;
  description?: string;
  organizationId: string;
  ownerId: string;
}

export interface CardPayload {
  id: string;
  title: string;
  description?: string;
  columnId: string;
  projectId: string;
  assignees?: { id: string; name: string }[];
  priority: string;
  dueDate?: string;
  position: number;
}

export interface CardMovedPayload {
  cardId: string;
  fromColumnId: string;
  toColumnId: string;
  position: number;
  projectId: string;
}

export interface CardAssignedPayload {
  cardId: string;
  cardTitle: string;
  assigneeId: string;
  assigneeName: string;
  assignedById: string;
  assignedByName: string;
}

export interface ColumnPayload {
  id: string;
  name: string;
  projectId: string;
  position: number;
  wipLimit?: number;
  isDone: boolean;
}

export interface CommentPayload {
  id: string;
  cardId: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: string;
}

export interface ActivityPayload {
  id: string;
  projectId: string;
  cardId?: string;
  userId: string;
  userName: string;
  type: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface StaleCardPayload {
  cardId: string;
  cardTitle: string;
  columnName: string;
  daysInactive: number;
  assigneeId?: string;
  assigneeName?: string;
}

export interface WorkloadPayload {
  userId: string;
  userName: string;
  taskCount: number;
  weightedCount: number;
  threshold: number;
}

export interface DeadlineRiskPayload {
  cardId: string;
  cardTitle: string;
  dueDate: string;
  daysRemaining: number;
  assigneeId?: string;
  assigneeName?: string;
  reason: "stale" | "blocked" | "approaching";
}

export interface TypingPayload {
  userId: string;
  userName: string;
  cardId?: string;
  columnId?: string;
  projectId?: string;
  isTyping: boolean;
}

// Socket with user info
export interface AuthenticatedSocket extends Socket {
  userId?: string;
  userName?: string;
  userEmail?: string;
  organizations?: string[];
  projects?: string[];
}

// server.ts (require ile) ve Next'in API route'lari (Next'in kendi bundler'i
// uzerinden import ile) bu dosyayi IKI AYRI modul kopyasi olarak yukluyor.
// globalThis ile tum surec icinde TEK bir io referansi garantileniyor.
const globalForSocket = globalThis as unknown as { __io?: SocketIOServer<ServerSocketEvents> };

export function getIO(): SocketIOServer<ServerSocketEvents> | null {
  return globalForSocket.__io ?? null;
}

export function initializeSocket(httpServer: HttpServer): SocketIOServer<ServerSocketEvents> {
  if (globalForSocket.__io) return globalForSocket.__io;

  const io = new SocketIOServer<ServerSocketEvents>(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  globalForSocket.__io = io;

  // Authentication middleware
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;

      if (!token) return next(new Error("Authentication required"));

      const payload = verifyToken(token as string);
      if (!payload) return next(new Error("Invalid token"));

      // Fetch user from DB to ensure they still exist
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { id: true, name: true, email: true },
      });

      if (!user) return next(new Error("User not found"));

      socket.userId = user.id;
      socket.userName = user.name;
      socket.userEmail = user.email;

      // Fetch user's organizations for room joining
      const memberships = await prisma.organizationMember.findMany({
        where: { userId: user.id },
        select: { organizationId: true },
      });

      socket.organizations = memberships.map((m) => m.organizationId);

      // Fetch user's projects
      const projects = await prisma.project.findMany({
        where: {
          OR: [
            { ownerId: user.id },
            { organization: { members: { some: { userId: user.id } } } },
          ],
        },
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
    console.log(`Socket connected: ${socket.userName} (${socket.userId})`);

    // Join user's personal room
    socket.join(`user:${socket.userId}`);

    // Join organization rooms
    if (socket.organizations) {
      for (const orgId of socket.organizations) {
        socket.join(`org:${orgId}`);
      }
    }

    // Join project rooms
    if (socket.projects) {
      for (const projectId of socket.projects) {
        socket.join(`project:${projectId}`);
      }
    }

    // Emit authenticated event
    socket.emit(SocketEvents.AUTHENTICATED, {
      id: socket.userId,
      name: socket.userName,
      email: socket.userEmail,
    });

    // Broadcast user online status
    broadcastUserOnline(socket.userId!);

    // Handle disconnect
    socket.on("disconnect", (reason) => {
      console.log(`Socket disconnected: ${socket.userName} (${socket.userId}) - ${reason}`);
      broadcastUserOffline(socket.userId!);
    });

    // Handle typing indicator
    socket.on(SocketEvents.USER_TYPING, (data: TypingPayload) => {
      if (data.projectId) {
        socket.to(`project:${data.projectId}`).emit(SocketEvents.USER_TYPING, {
          userId: socket.userId,
          userName: socket.userName,
          cardId: data.cardId,
          isTyping: data.isTyping,
        });
      }
    });

    // Handle joining specific project room (for real-time board updates)
    socket.on("join:project", (projectId: string) => {
      socket.join(`project:${projectId}`);
    });

    socket.on("leave:project", (projectId: string) => {
      socket.leave(`project:${projectId}`);
    });

    // Handle joining org room (for invitation acceptance)
    socket.on("join:org", (organizationId: string) => {
      socket.join(`org:${organizationId}`);
    });

    // Handle joining card room (for comments, activity)
    socket.on("join:card", (cardId: string) => {
      socket.join(`card:${cardId}`);
    });

    socket.on("leave:card", (cardId: string) => {
      socket.leave(`card:${cardId}`);
    });
  });

  console.log("[SOCKET] Socket.io sunucusu baslatildi");
  return io;
}

type SocketEventName = keyof ServerSocketEvents & string;

export function broadcastToUser(userId: string, event: SocketEventName, data: unknown) {
  const ioServer = getIO();
  if (!ioServer) {
    console.log(`[SOCKET] broadcastToUser: io is null, cannot emit ${event} to user:${userId}`);
    return;
  }
  (ioServer.to(`user:${userId}`).emit as (event: string, data: unknown) => void)(event, data);
}

export function broadcastToOrganization(organizationId: string, event: SocketEventName, data: unknown) {
  const ioServer = getIO();
  if (!ioServer) return;
  (ioServer.to(`org:${organizationId}`).emit as (event: string, data: unknown) => void)(event, data);
}

export function broadcastToProject(projectId: string, event: SocketEventName, data: unknown) {
  const ioServer = getIO();
  if (!ioServer) return;
  (ioServer.to(`project:${projectId}`).emit as (event: string, data: unknown) => void)(event, data);
}

export function broadcastToCard(cardId: string, event: SocketEventName, data: unknown) {
  const ioServer = getIO();
  if (!ioServer) return;
  (ioServer.to(`card:${cardId}`).emit as (event: string, data: unknown) => void)(event, data);
}

function broadcastUserOnline(userId: string) {
  const ioServer = getIO();
  if (!ioServer) return;
  ioServer.emit(SocketEvents.USER_ONLINE, userId);
}

function broadcastUserOffline(userId: string) {
  const ioServer = getIO();
  if (!ioServer) return;
  ioServer.emit(SocketEvents.USER_OFFLINE, userId);
}
