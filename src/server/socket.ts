// Socket.io server setup for real-time notifications
import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { verifyToken } from "@/utils/jwt";
import { prisma } from "@/lib/prisma";
import { checkProjectAccess, checkCardAccess, filterVisibleProjects } from "@/services/access-control.service";

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

  [SocketEvents.ATTACHMENT_ADDED]: (attachment: AttachmentPayload) => void;
  [SocketEvents.ATTACHMENT_DELETED]: (data: { cardId: string; attachmentId: string }) => void;

  // Checklist (alt gorev listesi) events
  [SocketEvents.CHECKLIST_ITEM_ADDED]: (item: ChecklistItemPayload) => void;
  [SocketEvents.CHECKLIST_ITEM_UPDATED]: (item: ChecklistItemPayload) => void;
  [SocketEvents.CHECKLIST_ITEM_DELETED]: (data: { cardId: string; itemId: string }) => void;

  // Organizasyon sohbeti
  [SocketEvents.CHAT_MESSAGE_NEW]: (message: ChatMessagePayload) => void;
  [SocketEvents.CHAT_TYPING]: (data: ChatTypingPayload) => void;

  // Degisiklik talepleri
  [SocketEvents.REQUEST_CREATED]: (request: unknown) => void;
  [SocketEvents.REQUEST_REVIEWED]: (request: unknown) => void;

  // Bağımlılık events
  [SocketEvents.DEPENDENCY_ADDED]: (data: DependencyPayload) => void;
  [SocketEvents.DEPENDENCY_REMOVED]: (data: DependencyPayload) => void;

  // Ek alan (custom field) events
  [SocketEvents.CUSTOM_FIELD_CHANGED]: (data: { projectId: string; cardId?: string }) => void;

  // Activity events
  [SocketEvents.ACTIVITY_NEW]: (activity: ActivityPayload) => void;

  // Stale/Insight events
  [SocketEvents.STALE_CARD_DETECTED]: (data: StaleCardPayload) => void;
  [SocketEvents.WORKLOAD_IMBALANCE]: (data: WorkloadPayload) => void;
  [SocketEvents.DEADLINE_RISK]: (data: DeadlineRiskPayload) => void;

  // Git Cakisma Erken Uyari (VSCode extension presence sinyalinden turetilir)
  [SocketEvents.CONFLICT_DETECTED]: (data: ConflictPayload) => void;
  [SocketEvents.CONFLICT_RESOLVED]: (data: ConflictResolvedPayload) => void;

  // Presence
  [SocketEvents.USER_ONLINE]: (userId: string) => void;
  [SocketEvents.USER_OFFLINE]: (userId: string) => void;
  [SocketEvents.USER_TYPING]: (data: TypingPayload) => void;

  // Sirket ici mailbox
  [SocketEvents.MAIL_NEW]: (data: { mailId: string; subject: string; senderName: string }) => void;
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

  CHECKLIST_ITEM_ADDED = "checklist:item:added",
  CHECKLIST_ITEM_UPDATED = "checklist:item:updated",
  CHECKLIST_ITEM_DELETED = "checklist:item:deleted",

  // Kart eki (dosya/gorsel)
  ATTACHMENT_ADDED = "attachment:added",
  ATTACHMENT_DELETED = "attachment:deleted",

  // Organizasyon sohbeti
  CHAT_MESSAGE_NEW = "chat:message",
  CHAT_TYPING = "chat:typing",

  // Degisiklik talepleri (uye -> admin onayi)
  REQUEST_CREATED = "request:created",
  REQUEST_REVIEWED = "request:reviewed",

  // Bağımlılık
  DEPENDENCY_ADDED = "dependency:added",
  DEPENDENCY_REMOVED = "dependency:removed",

  // Ek alan (custom field)
  CUSTOM_FIELD_CHANGED = "custom_field:changed",

  // Activity
  ACTIVITY_NEW = "activity:new",

  // Insights/Proactive
  STALE_CARD_DETECTED = "insight:stale_card",
  WORKLOAD_IMBALANCE = "insight:workload_imbalance",
  DEADLINE_RISK = "insight:deadline_risk",

  // Git Cakisma Erken Uyari
  CONFLICT_DETECTED = "conflict:detected",
  CONFLICT_RESOLVED = "conflict:resolved",

  // Presence
  USER_ONLINE = "presence:online",
  USER_OFFLINE = "presence:offline",
  USER_TYPING = "presence:typing",

  // Sirket ici mailbox
  MAIL_NEW = "mail:new",
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
  startDate?: string | null;
  position: number;
  parentCardId?: string | null;
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

export interface AttachmentPayload {
  id: string;
  cardId: string;
  uploaderId: string;
  uploaderName: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: string;
}

export interface ChecklistItemPayload {
  id: string;
  cardId: string;
  text: string;
  done: boolean;
  position: number;
}

export interface ChatMessagePayload {
  id: string;
  organizationId: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: string;
}

export interface ChatTypingPayload {
  organizationId: string;
  userId: string;
  userName: string;
  isTyping: boolean;
}

export interface DependencyPayload {
  projectId: string;
  blockedId: string;
  blockerId: string;
  relationType?: string;
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

// VSCode extension'dan gelen "su an bu dosyada calisiyorum" sinyali
// dosya-seviyesinde kesisince uretilir. Satir/hunk analizi yok — bu yuzden
// "kesin cakisma" degil "risk" olarak sunulmali.
export interface ConflictCardRef {
  id: string;
  title: string;
  projectId: string;
}

export interface ConflictUserRef {
  id: string;
  name: string;
}

export interface ConflictPayload {
  filePath: string;
  cardA: ConflictCardRef;
  userA: ConflictUserRef;
  cardB: ConflictCardRef;
  userB: ConflictUserRef;
}

// Taraflardan biri dosyadan ayrilinca / baglantisi kopunca / kaydi bayatlayinca
// yayilir. cardIds cakisan iki kartin id'sidir; filePath ile birlikte gelir ki
// istemci ayni kartin BASKA bir dosyadaki aktif uyarisini yanlislikla silmesin.
export interface ConflictResolvedPayload {
  filePath: string;
  cardIds: [string, string];
}

// Socket with user info
export interface AuthenticatedSocket extends Socket {
  userId?: string;
  userName?: string;
  userEmail?: string;
  organizations?: string[];
  projects?: string[];
  // Token'in bitis zamani (ms). Handshake'te bir kez okunur, oturum taramasi
  // bunu kullanip suresi dolmus baglantilari dusurur (bkz. sweepExpiredSessions).
  tokenExpiresAt?: number;
}

// server.ts (require ile) ve Next'in API route'lari (Next'in kendi bundler'i
// uzerinden import ile) bu dosyayi IKI AYRI modul kopyasi olarak yukluyor.
// globalThis ile tum surec icinde TEK bir io referansi garantileniyor.
const globalForSocket = globalThis as unknown as { __io?: SocketIOServer<ServerSocketEvents> };

export function getIO(): SocketIOServer<ServerSocketEvents> | null {
  return globalForSocket.__io ?? null;
}

// ─── Oda Erisim Kontrolleri ─────────────────────────────────────────
// REST tarafindaki access-control.service.ts fonksiyonlarinin (checkProjectAccess/
// checkCardAccess) TEK dogruluk kaynagi olarak burada da kullanilmasi sart.
//
// Onceden bu fonksiyonlar kendi ham "sahip VEYA org uyesi" sorgularini
// calistiriyordu - bu, GUEST rolunu (yalnizca ACIKCA eklendigi projeleri
// gormesi gereken) ve PRIVATE/TEAM gorunurluklu projeleri tamamen atlatiyordu.
// Sonuc: REST API'de checkProjectAccess ile gizlenen bir proje/kart, socket
// odalarina (join:project, join:card) katilip canli kart/yorum/ek/checklist
// olaylarini dinleyerek okunabiliyordu. checkProjectAccess/checkCardAccess
// zaten NotFoundError/ForbiddenError firlatiyor - burada sadece true/false'a
// cevriliyor.
async function canAccessOrganization(userId: string, organizationId: string): Promise<boolean> {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { userId: true },
  });
  return Boolean(member);
}

async function canAccessProject(userId: string, projectId: string): Promise<boolean> {
  try {
    await checkProjectAccess(projectId, userId);
    return true;
  } catch {
    return false;
  }
}

async function canAccessCard(userId: string, cardId: string): Promise<boolean> {
  try {
    await checkCardAccess(cardId, userId);
    return true;
  } catch {
    return false;
  }
}

// Cakisma hesabi organizasyona gore kapsanmak zorunda oldugu icin kartin
// organizationId'si de tasiniyor (ConflictCardRef payload sekli degismedi).
type ErisilebilirKart = ConflictCardRef & { organizationId: string };

async function getAccessibleCard(userId: string, cardId: string): Promise<ErisilebilirKart | null> {
  try {
    const access = await checkCardAccess(cardId, userId);
    return { id: cardId, title: access.cardTitle, projectId: access.projectId, organizationId: access.organizationId };
  } catch {
    return null;
  }
}

// ─── Git Cakisma Erken Uyari — Presence Takibi ─────────────────────────
// Tek Node process oldugu icin (globalThis.__io ile ayni gerekce) Redis/DB
// gerekmiyor: sadece process bellegindeki bir Map yeterli. Kalici veri degil,
// VSCode'daki onSave/aktif-editor sinyallerinden turetilen anlik bir goruntu.

type PresenceEntry = {
  cardId: string;
  cardTitle: string;
  userName: string;
  projectId: string;
  organizationId: string;
  // Harita artik organizasyona gore kapsanmis bir anahtarla tutuldugu icin
  // dosya yolu kaydin kendisinde saklaniyor; conflict:resolved yayini bunu
  // anahtardan geri ayristirmak zorunda kalmasin.
  filePath: string;
  socketId: string;
  lastSeenAt: number;
};

// Bu suredir yeni sinyal gelmemis kayit "bayat" sayilir ve cakisma hesabina
// katilmaz. Aksi halde VSCode'u acik birakip giden birinin kaydi sonsuza
// kadar durur ve ertesi gun ayni dosyaya dokunan herkese yanlis alarm basar.
// Yanlis alarm bu ozelligin en buyuk dusmani: birikince rozet ciddiye alinmaz.
const PRESENCE_TTL_MS = 15 * 60 * 1000; // 15 dakika
const PRESENCE_SWEEP_MS = 5 * 60 * 1000; // bayat kayit taramasi araligi

// "org::filePath" -> userId -> o an o dosyada hangi kartla calistigi.
//
// Anahtar SADECE filePath olsaydi (onceki hali) harita tum kiracilar icin
// ortak olurdu: `package.json`, `src/app/page.tsx` gibi yollar farkli
// musteriler arasinda neredeyse kesin cakisir ve karsi tarafin KART BASLIGI,
// projectId'si ve kullanici adi hic ilgisi olmayan bir organizasyonun pano
// odasina yayinlanirdi. Kapsam anahtara tasinarak cakisma hesabi organizasyon
// sinirinin disina cikamaz hale getirildi.
const presenceByFile = new Map<string, Map<string, PresenceEntry>>();
// socket.id -> en son bildirilen presence anahtari ("org::filePath"),
// kullanici dosya degistirince eskisini temizlemek icin
const lastFileBySocket = new Map<string, string>();

// Cakisma haritasinin organizasyon kapsamli anahtari.
function presenceKey(organizationId: string, filePath: string): string {
  return `${organizationId}::${filePath}`;
}

// Cakisan iki kart FARKLI projelerdeyse, karsi tarafin basligini o projeye
// erisimi olmayan odaya yollamamak icin baslik bu metinle degistirilir —
// uyarinin kendisi (dosya + kisi) yine gorunur, icerik sizmaz.
const GIZLI_KART_BASLIGI = "Erişiminiz olmayan bir kart";

function isFresh(entry: PresenceEntry): boolean {
  return Date.now() - entry.lastSeenAt < PRESENCE_TTL_MS;
}

// Bir kaydi haritalardan cikarir ve bu cikis yuzunden ortadan kalkan
// cakismalar icin conflict:resolved yayinlar — boylece panodaki rozet
// sayfa yenilenmeden kaybolur.
function removePresence(key: string, userId: string) {
  const users = presenceByFile.get(key);
  if (!users) return;

  const leaving = users.get(userId);
  if (!leaving) return;

  users.delete(userId);
  lastFileBySocket.delete(leaving.socketId);
  if (users.size === 0) presenceByFile.delete(key);

  for (const [otherUserId, other] of users) {
    if (otherUserId === userId) continue;
    if (other.cardId === leaving.cardId) continue;
    if (!isFresh(other)) continue;

    const payload: ConflictResolvedPayload = {
      filePath: leaving.filePath,
      cardIds: [leaving.cardId, other.cardId],
    };

    broadcastToProject(leaving.projectId, SocketEvents.CONFLICT_RESOLVED, payload);
    if (other.projectId !== leaving.projectId) {
      broadcastToProject(other.projectId, SocketEvents.CONFLICT_RESOLVED, payload);
    }
  }
}

function clearPresence(socketId: string, userId: string) {
  const prevKey = lastFileBySocket.get(socketId);
  lastFileBySocket.delete(socketId);
  if (!prevKey) return;
  removePresence(prevKey, userId);
}

// Bir dosyadaki bayat kayitlari atar. Map uzerinde iterasyon sirasinda silme
// JS'te guvenli, ama removePresence dosya bosalinca presenceByFile'dan girdiyi
// silebilecegi icin cagiran taraf haritayi SONRADAN yeniden almalidir.
function pruneStaleOnFile(key: string) {
  const users = presenceByFile.get(key);
  if (!users) return;
  for (const [userId, entry] of users) {
    if (!isFresh(entry)) removePresence(key, userId);
  }
}

function sweepStalePresence() {
  for (const [key, users] of presenceByFile) {
    for (const [userId, entry] of users) {
      if (!isFresh(entry)) removePresence(key, userId);
    }
  }
}

// Oturum yalnizca handshake aninda dogrulaniyordu: token'in suresi dolsa ya da
// kullanici silinse bile acik socket, baglanti kopana kadar kart/yorum/sohbet
// olaylarini almaya devam ediyordu (REST tarafi 401 verirken socket canli).
// Bu tarama, dogrulamayi periyodik hale getirip artik gecerli olmayan
// baglantilari dusurur.
//
// Socket basina degil TEK sorgu ile calisiyor: yasayan kullanicilar tek bir
// findMany ile bulunuyor. Havuz sinirina (Supabase pool_size 15) duyarli bir
// kod tabani oldugu icin socket basina periyodik sorgu bilerek yapilmadi.
const SESSION_SWEEP_MS = 5 * 60 * 1000; // oturum yeniden dogrulama araligi

async function sweepExpiredSessions() {
  const simdi = Date.now();
  const kalanlar: AuthenticatedSocket[] = [];

  for (const socket of yereldekiSocketler()) {
    if (socket.tokenExpiresAt !== undefined && socket.tokenExpiresAt <= simdi) {
      socket.emit(SocketEvents.AUTH_ERROR, "Oturum suresi doldu");
      socket.disconnect(true);
      continue;
    }
    if (socket.userId) kalanlar.push(socket);
  }

  const userIdleri = [...new Set(kalanlar.map((s) => s.userId!))];
  if (userIdleri.length === 0) return;

  const yasayanlar = await prisma.user.findMany({
    where: { id: { in: userIdleri } },
    select: { id: true },
  });
  const yasayanSet = new Set(yasayanlar.map((u) => u.id));

  for (const socket of kalanlar) {
    if (yasayanSet.has(socket.userId!)) continue;
    socket.emit(SocketEvents.AUTH_ERROR, "Kullanici bulunamadi");
    socket.disconnect(true);
  }
}

export function initializeSocket(httpServer: HttpServer): SocketIOServer<ServerSocketEvents> {
  if (globalForSocket.__io) return globalForSocket.__io;

  const io = new SocketIOServer<ServerSocketEvents>(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL
        ? [
            ...process.env.FRONTEND_URL.split(",").map((origin) => origin.trim()).filter(Boolean),
            "http://localhost:3000",
            "http://localhost:3001",
          ]
        : ["http://localhost:3000", "http://localhost:3001"],
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
      // Yalnizca handshake.auth.token kabul edilir. query.token kaldirildi:
      // token'i URL'e koymak proxy/log/analiz servislerine düz metin olarak
      // sizdirirdi (güvenlik bulgusu 3).
      const token = socket.handshake.auth.token;

      if (!token) return next(new Error("Authentication required"));

      const payload = verifyToken(token as string);
      if (!payload) return next(new Error("Invalid token"));

      // Token'in "exp" degeri saklaniyor: oturum yalnizca handshake aninda
      // dogrulaniyordu, sonrasinda hicbir kontrol yoktu. JWT omru 7 gun ve
      // socket pingInterval ile suresiz canli tutuldugu icin, suresi dolmus
      // (REST'te 401 alan) bir oturum socket'ten yayin almaya devam ediyordu.
      const tokenExp = (payload as unknown as { exp?: number }).exp;
      socket.tokenExpiresAt = typeof tokenExp === "number" ? tokenExp * 1000 : undefined;

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
        select: { organizationId: true, role: true },
      });

      socket.organizations = memberships.map((m) => m.organizationId);

      // Fetch user's projects — yalnizca GORUNUR olanlar. Ham "sahip VEYA org
      // uyesi" sorgusu GUEST rolunu ve PRIVATE/TEAM gorunurlugunu atlatirdi:
      // baglanti aninda TUM org projelerinin odasina otomatik katilip REST'te
      // erisimi olmayan projelerin canli kart/yorum olaylarini dinleyebilirdi.
      // access-control.service.ts'teki filterVisibleProjects REST tarafiyla
      // (checkProjectAccess) ayni kurali uygular.
      const orgProjects = await prisma.project.findMany({
        where: { organizationId: { in: socket.organizations } },
        select: { id: true, ownerId: true, visibility: true, organizationId: true },
      });
      const visibleProjectIds: string[] = [];
      for (const { organizationId, role } of memberships) {
        const inOrg = orgProjects.filter((p) => p.organizationId === organizationId);
        const visible = await filterVisibleProjects(inOrg, user.id, role);
        visibleProjectIds.push(...visible.map((p) => p.id));
      }

      socket.projects = visibleProjectIds;

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

    // Broadcast user online status — yalnizca kullanicinin org odalarina
    broadcastUserOnline(socket.userId!, socket);

    // Handle disconnect
    socket.on("disconnect", (reason) => {
      console.log(`Socket disconnected: ${socket.userName} (${socket.userId}) - ${reason}`);
      clearPresence(socket.id, socket.userId!);
      broadcastUserOffline(socket.userId!, socket);
    });

    // VSCode extension: kullanici bir dosyayi kaydetti / aktif editoru degisti.
    // Ayni dosyada FARKLI bir kartla calisan baska biri varsa conflict:detected yayilir.
    socket.on("presence:file", async (data: { cardId?: string; filePath?: string }) => {
      if (!socket.userId || !data?.cardId || !data?.filePath) return;

      const cardInfo = await getAccessibleCard(socket.userId, data.cardId);
      if (!cardInfo) return;

      // Kullanicinin onceki dosyasindaki kaydini temizle — tek seferde tek dosya sayilir.
      clearPresence(socket.id, socket.userId);

      const filePath = data.filePath;
      // Kapsam anahtari: ayni dosya yolunda calisan iki kisi ancak AYNI
      // organizasyondaysa cakisma sayilir (bkz. presenceByFile notu).
      const key = presenceKey(cardInfo.organizationId, filePath);

      // Bayat kayitlari kendi girdimizi eklemeden ONCE at: hem yanlis alarmi
      // onler hem de temizlik sirasinda cikan conflict:resolved yayinlarinin
      // bizim yeni girdimizi hesaba katmasini engeller.
      pruneStaleOnFile(key);

      // pruneStaleOnFile dosyayi bosaltip haritadan silmis olabilir, bu yuzden
      // referans temizlikten SONRA aliniyor.
      let usersOnFile = presenceByFile.get(key);
      if (!usersOnFile) {
        usersOnFile = new Map();
        presenceByFile.set(key, usersOnFile);
      }
      usersOnFile.set(socket.userId, {
        cardId: cardInfo.id,
        cardTitle: cardInfo.title,
        userName: socket.userName || "Bilinmeyen",
        projectId: cardInfo.projectId,
        organizationId: cardInfo.organizationId,
        filePath,
        socketId: socket.id,
        lastSeenAt: Date.now(),
      });
      lastFileBySocket.set(socket.id, key);

      for (const [otherUserId, otherInfo] of usersOnFile) {
        if (otherUserId === socket.userId) continue;
        if (otherInfo.cardId === cardInfo.id) continue; // ayni kart = isbirligi, cakisma degil

        const cardA: ConflictCardRef = { id: cardInfo.id, title: cardInfo.title, projectId: cardInfo.projectId };
        const cardB: ConflictCardRef = { id: otherInfo.cardId, title: otherInfo.cardTitle, projectId: otherInfo.projectId };
        const userA: ConflictUserRef = { id: socket.userId, name: socket.userName || "Bilinmeyen" };
        const userB: ConflictUserRef = { id: otherUserId, name: otherInfo.userName };
        const ayriProje = otherInfo.projectId !== cardInfo.projectId;

        // Ayni organizasyon icinde bile iki kart farkli projelerde olabilir ve
        // proje odasindaki herkesin oteki projeye erisimi yok (GUEST/TEAM/
        // PRIVATE). Bu yuzden her odaya yalnizca KENDI kartinin basligi tam
        // gonderiliyor, karsi tarafinki maskeleniyor.
        broadcastToProject(cardInfo.projectId, SocketEvents.CONFLICT_DETECTED, {
          filePath,
          cardA,
          userA,
          cardB: ayriProje ? { ...cardB, title: GIZLI_KART_BASLIGI } : cardB,
          userB,
        } satisfies ConflictPayload);

        if (ayriProje) {
          broadcastToProject(otherInfo.projectId, SocketEvents.CONFLICT_DETECTED, {
            filePath,
            cardA: { ...cardA, title: GIZLI_KART_BASLIGI },
            userA,
            cardB,
            userB,
          } satisfies ConflictPayload);
        }
      }
    });

    // Kullanici karttan ayrildi / oturumu kapatti — presence kaydini elle temizle
    socket.on("presence:clear", () => {
      if (!socket.userId) return;
      clearPresence(socket.id, socket.userId);
    });

    // Handle typing indicator
    socket.on(SocketEvents.USER_TYPING, (data: TypingPayload) => {
      if (!data.projectId) return;
      // Erisimi olmayan biri baskasinin panosuna "yaziyor..." basmasin.
      // Oda uyeligi yeterli kanit: proje odalarina giris DB ile dogrulaniyor.
      const canBroadcast =
        socket.projects?.includes(data.projectId) ||
        socket.rooms.has(`project:${data.projectId}`);
      if (!canBroadcast) return;

      socket.to(`project:${data.projectId}`).emit(SocketEvents.USER_TYPING, {
        userId: socket.userId,
        userName: socket.userName,
        cardId: data.cardId,
        isTyping: data.isTyping,
      });
    });

    // Organizasyon sohbetinde "yaziyor..." bilgisi.
    // Kalici veri yok; sadece ayni org odasindaki digerlerine iletilir.
    socket.on(SocketEvents.CHAT_TYPING, (data: { organizationId?: string; isTyping?: boolean }) => {
      const orgId = data?.organizationId;
      if (!orgId) return;
      // Sadece gercekten uyesi oldugu organizasyona yayabilsin.
      // Iki kaynak da guvenilir: socket.organizations baglanti aninda DB'den
      // dogrulandi, org odasina giris ise "join:org" handler'inda DB'den
      // dogrulaniyor. Yani odada olmak, uyeligin kanitidir.
      const isMember =
        socket.organizations?.includes(orgId) || socket.rooms.has(`org:${orgId}`);
      if (!isMember) return;

      socket.to(`org:${orgId}`).emit(SocketEvents.CHAT_TYPING, {
        organizationId: orgId,
        userId: socket.userId!,
        userName: socket.userName!,
        isTyping: Boolean(data.isTyping),
      });
    });

    // Oda katilimlari ISTEMCIDEN gelen ID ile tetikleniyor; bu yuzden uyelik
    // her seferinde veritabanindan dogrulanir. Aksi halde herhangi bir kayitli
    // kullanici rastgele bir ID yollayip uyesi olmadigi organizasyonun sohbetini,
    // kart hareketlerini ve degisiklik taleplerini canli dinleyebilir.
    //
    // Dogrulama socket.organizations/projects listelerine DAYANMAZ: onlar
    // baglanti anindaki anlik goruntudur ve davet kabulunden sonra bayat kalir
    // (bu handler'larin var olma sebebi de zaten o).
    //
    // Her join ISTEGE BAGLI bir ack (onay) callback'i kabul eder. Bunun iki
    // sebebi var:
    //   1. Katilim asenkron ve DB'ye bagli (uzak Supabase'te ~140ms, kart icin
    //      3 sorgu ~450ms). Ack olmadan cagiran tarafin elinde "yeterince
    //      bekle" tahmininden baska bir sey yok - socket-authorization
    //      testinin 300/400ms'lik uykularla flake vermesinin sebebi tam
    //      buydu (yuk altinda sorgu uykudan uzun suruyor, yayin kaciriliyor).
    //   2. Reddedilen katilim ISTEMCIYE sessiz kaliyordu: frontend odaya
    //      giremedigini hic ogrenemiyor, sadece "hicbir canli guncelleme
    //      gelmiyor" olarak yasiyordu. Ack ile artik ayirt edilebilir.
    // Ack callback'i gondermeyen eski istemciler etkilenmez (typeof kontrolu).
    type JoinAck = (sonuc: { ok: boolean; reason?: string }) => void;
    const cevapla = (ack: unknown, sonuc: { ok: boolean; reason?: string }) => {
      if (typeof ack === "function") (ack as JoinAck)(sonuc);
    };

    socket.on("join:project", async (projectId: string, ack?: JoinAck) => {
      if (!projectId || !socket.userId) return cevapla(ack, { ok: false, reason: "INVALID" });
      if (!(await canAccessProject(socket.userId, projectId))) {
        console.warn(`[SOCKET] Yetkisiz join:project reddedildi — user:${socket.userId} project:${projectId}`);
        return cevapla(ack, { ok: false, reason: "FORBIDDEN" });
      }
      socket.join(`project:${projectId}`);
      if (socket.projects && !socket.projects.includes(projectId)) {
        socket.projects.push(projectId);
      }
      cevapla(ack, { ok: true });
    });

    socket.on("leave:project", (projectId: string) => {
      socket.leave(`project:${projectId}`);
    });

    // Davet kabul edildiginde yeniden baglanmadan odaya girebilmek icin
    socket.on("join:org", async (organizationId: string, ack?: JoinAck) => {
      if (!organizationId || !socket.userId) return cevapla(ack, { ok: false, reason: "INVALID" });
      if (!(await canAccessOrganization(socket.userId, organizationId))) {
        console.warn(`[SOCKET] Yetkisiz join:org reddedildi — user:${socket.userId} org:${organizationId}`);
        return cevapla(ack, { ok: false, reason: "FORBIDDEN" });
      }
      socket.join(`org:${organizationId}`);
      if (socket.organizations && !socket.organizations.includes(organizationId)) {
        socket.organizations.push(organizationId);
      }
      cevapla(ack, { ok: true });
    });

    socket.on("join:card", async (cardId: string, ack?: JoinAck) => {
      if (!cardId || !socket.userId) return cevapla(ack, { ok: false, reason: "INVALID" });
      if (!(await canAccessCard(socket.userId, cardId))) {
        console.warn(`[SOCKET] Yetkisiz join:card reddedildi — user:${socket.userId} card:${cardId}`);
        return cevapla(ack, { ok: false, reason: "FORBIDDEN" });
      }
      socket.join(`card:${cardId}`);
      cevapla(ack, { ok: true });
    });

    socket.on("leave:card", (cardId: string) => {
      socket.leave(`card:${cardId}`);
    });
  });

  // Bayat presence kayitlarini periyodik olarak at. Sadece presence:file
  // geldiginde temizlemek yetmez: cakisan taraf VSCode'u acik birakip giderse
  // yeni sinyal hic gelmez ve rozet panoda asili kalirdi.
  // unref(): bu zamanlayici surecin kapanmasini geciktirmesin.
  setInterval(sweepStalePresence, PRESENCE_SWEEP_MS).unref();

  // Suresi dolmus / kullanicisi silinmis oturumlari periyodik olarak dusur.
  // Tarama DB'ye gittigi icin hatasi surekliligi bozmasin diye yutuluyor.
  setInterval(() => {
    void sweepExpiredSessions().catch((error) => {
      console.error("[SOCKET] Oturum taramasi hatasi:", error);
    });
  }, SESSION_SWEEP_MS).unref();

  console.log("[SOCKET] Socket.io sunucusu baslatildi");
  return io;
}

type SocketEventName = keyof ServerSocketEvents & string;

export function broadcastToUser(userId: string, event: SocketEventName, data: unknown) {
  const ioServer = getIO();
  console.log(`[SOCKET BROADCAST] User: ${userId}, Event: ${event}, IO initialized: ${!!ioServer}`);
  if (!ioServer) {
    console.warn(`[SOCKET] broadcastToUser: io is null, cannot emit ${event} to user:${userId}`);
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
  console.log(`[SOCKET BROADCAST] Project: ${projectId}, Event: ${event}, IO initialized: ${!!ioServer}`);
  if (!ioServer) {
    console.warn(`[SOCKET BROADCAST] Warning: getIO() returned null! Broadcast failed.`);
    return;
  }
  (ioServer.to(`project:${projectId}`).emit as (event: string, data: unknown) => void)(event, data);
}

export function broadcastToCard(cardId: string, event: SocketEventName, data: unknown) {
  const ioServer = getIO();
  console.log(`[SOCKET BROADCAST] Card: ${cardId}, Event: ${event}, IO initialized: ${!!ioServer}`);
  if (!ioServer) {
    console.warn(`[SOCKET BROADCAST] Warning: getIO() returned null! Broadcast failed.`);
    return;
  }
  (ioServer.to(`card:${cardId}`).emit as (event: string, data: unknown) => void)(event, data);
}


// ─── Yetki Iptalinin Canli Baglantilara Yansitilmasi ───────────────────
// Oda uyeligi SADECE handshake aninda hesaplaniyordu ve bir daha hic
// tazelenmiyordu: org'dan/projeden cikarilan kullanici REST'te 403 alirken
// acik socket'i `org:<id>` / `project:<id>` odalarinda kaliyor ve kart, yorum,
// sohbet olaylarini baglanti kopana kadar (pingInterval ile saatlerce)
// okumaya devam ediyordu. Asagidaki yardimcilar yetki iptalini canli
// baglantiya da uygular; uyeligi degistiren servisler bunlari cagirir.
//
// Odadan cikarmanin yaninda socket.organizations/socket.projects listeleri de
// temizleniyor: chat:typing ve presence:typing kontrolleri oda uyeliginin
// yaninda BU listelere de bakiyor, sadece leave() yayin yetkisini kapatmiyor.
//
// Tek Node process varsayimi globalThis.__io ile ayni gerekceye dayaniyor;
// bu yuzden yerel socket listesi uzerinden calisiliyor.
function yereldekiSocketler(userId?: string): AuthenticatedSocket[] {
  const ioServer = getIO();
  if (!ioServer) return [];
  const hepsi = Array.from(ioServer.sockets.sockets.values()) as unknown as AuthenticatedSocket[];
  return userId ? hepsi.filter((s) => s.userId === userId) : hepsi;
}

// Kart odalari (join:card) proje odasindan bagimsiz calisiyor: proje odasindan
// cikmak tek basina yorum/ek/checklist olaylarini kesmiyor. Socket'in icinde
// bulundugu kart odalarindan kapsama girenler tek sorguda bulunup terk edilir.
async function kartOdalariniTerkEt(
  socket: AuthenticatedSocket,
  kapsam: { organizationId?: string; projectId?: string },
) {
  const kartIdleri = [...socket.rooms].filter((r) => r.startsWith("card:")).map((r) => r.slice(5));
  if (kartIdleri.length === 0) return;

  const kartlar = await prisma.card.findMany({
    where: {
      id: { in: kartIdleri },
      column: kapsam.projectId
        ? { projectId: kapsam.projectId }
        : { project: { organizationId: kapsam.organizationId } },
    },
    select: { id: true },
  });
  for (const kart of kartlar) socket.leave(`card:${kart.id}`);
}

export async function evictFromProject(projectId: string, userId: string) {
  for (const socket of yereldekiSocketler(userId)) {
    socket.leave(`project:${projectId}`);
    if (socket.projects) socket.projects = socket.projects.filter((id) => id !== projectId);
    await kartOdalariniTerkEt(socket, { projectId });
  }
}

export async function evictFromOrganization(organizationId: string, userId: string) {
  const socketler = yereldekiSocketler(userId);
  if (socketler.length === 0) return;

  const projeler = await prisma.project.findMany({
    where: { organizationId },
    select: { id: true },
  });
  const projeIdleri = new Set(projeler.map((p) => p.id));

  for (const socket of socketler) {
    socket.leave(`org:${organizationId}`);
    if (socket.organizations) {
      socket.organizations = socket.organizations.filter((id) => id !== organizationId);
    }
    for (const projeId of projeIdleri) socket.leave(`project:${projeId}`);
    if (socket.projects) socket.projects = socket.projects.filter((id) => !projeIdleri.has(id));
    await kartOdalariniTerkEt(socket, { organizationId });
  }
}

// Cagiran servislerde okunusu daha dogal olan takma ad (userId once).
export function evictUserFromOrgRooms(userId: string, organizationId: string) {
  return evictFromOrganization(organizationId, userId);
}

// Gorunurluk daraltildiginda (ORG -> TEAM/PRIVATE) kimin erisimini
// kaybettigi tek tek belli degil; odadaki HERKESIN erisimi REST ile ayni
// kurala (checkProjectAccess) gore yeniden hesaplanir.
export async function revalidateProjectRoom(projectId: string) {
  const oda = `project:${projectId}`;
  const kaybedenler = new Set<string>();

  for (const socket of yereldekiSocketler()) {
    if (!socket.userId || !socket.rooms.has(oda)) continue;
    if (kaybedenler.has(socket.userId)) continue;
    if (await canAccessProject(socket.userId, projectId)) continue;
    kaybedenler.add(socket.userId);
  }

  for (const userId of kaybedenler) await evictFromProject(projectId, userId);
}

// Online/offline durumu TUM bagli istemcilere degil, yalnizca o kullanicinin
// uyesi oldugu organizasyon odalarina yayinlanir. Global emit, hic tanimadigi
// org'daki kullanicilarin anlik durumunu herkese sizdiriyordu (güvenlik bulgusu 12).
// Kullanici duz metin bir userId oldugu icin bu islevin kendisi zaten odalara
// kirilmis bir yayin olmali; org uyeligi baglanti aninda DB'den dogrulaniyor
// ve socket.organizations listesi bu esnada dolu oluyor.
function broadcastUserOnline(userId: string, socket: AuthenticatedSocket) {
  const ioServer = getIO();
  if (!ioServer) return;
  for (const orgId of socket.organizations ?? []) {
    ioServer.to(`org:${orgId}`).emit(SocketEvents.USER_ONLINE, userId);
  }
}

function broadcastUserOffline(userId: string, socket: AuthenticatedSocket) {
  const ioServer = getIO();
  if (!ioServer) return;
  for (const orgId of socket.organizations ?? []) {
    ioServer.to(`org:${orgId}`).emit(SocketEvents.USER_OFFLINE, userId);
  }
}
