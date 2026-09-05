import { prisma } from "@/lib/prisma";
import { NotFoundError, ConflictError, ForbiddenError } from "@/utils/errors";
import * as notificationService from "@/services/notification.service";
import { filterVisibleProjects } from "@/services/access-control.service";
import { broadcastToOrganization, SocketEvents, evictFromOrganization } from "@/server/socket";
import type { CreateOrganizationInput, UpdateOrganizationInput, AddMemberInput, UpdateMemberRoleInput } from "@/schemas/organization.schema";
import type { Role } from "@prisma/client";

// Kullanıcının bir organizasyonda üye olup olmadığını kontrol et
async function checkMembership(organizationId: string, userId: string) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  return member;
}

// Kullanıcının ADMIN olup olmadığını kontrol et
async function checkAdmin(organizationId: string, userId: string) {
  const member = await checkMembership(organizationId, userId);
  return member?.role === "ADMIN";
}

// --- CRUD ---

export async function createOrganization(input: CreateOrganizationInput, userId: string) {
  const org = await prisma.organization.create({
    data: {
      name: input.name,
      description: input.description,
      ownerId: userId,
      members: {
        create: { userId, role: "ADMIN" },
      },
    },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, email: true } } },
      },
    },
  });

  return org;
}

export async function getMyOrganizations(userId: string) {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId },
    include: {
      organization: {
        include: {
          _count: { select: { members: true, projects: true } },
        },
      },
    },
    orderBy: { joinedAt: "desc" },
  });

  return memberships.map((m) => ({
    ...m.organization,
    role: m.role,
    memberCount: m.organization._count.members,
    projectCount: m.organization._count.projects,
  }));
}

export async function getOrganizationById(organizationId: string, userId: string) {
  // Uyelik kontrolu ile asil sorgu birbirinden bagimsiz: paralel calistirip
  // bir gidis-donus kazaniyoruz. Yetki yoksa veri donmeden hata firlatiliyor.
  const [member, org] = await Promise.all([
    checkMembership(organizationId, userId),
    prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        badges: {
          include: {
            users: { include: { user: { select: { id: true, name: true } } } },
          },
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                avatarUrl: true,
                badges: { include: { badge: true } },
              },
            },
          },
        },
        projects: {
          // ownerId/visibility yalnizca gorunurluk filtresi icin cekiliyor,
          // cevaba konulmuyor (asagida ayikaniyor).
          select: { id: true, name: true, description: true, createdAt: true, ownerId: true, visibility: true },
          orderBy: { createdAt: "desc" },
        },
      },
    }),
  ]);

  if (!member) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");

  if (!org) throw new NotFoundError("Organizasyon");

  // Bu uc org'un TUM projelerini filtresiz donduruyordu: GUEST'e ve PRIVATE/TEAM
  // projeye eklenmemis MEMBER'a proje adi + aciklamasi siziyordu. GET /projects
  // ile ayni kurali uygulamak icin access-control'un tek gercek kaynagindan
  // geciriyoruz; disari donen sekil eskisiyle ayni kalsin diye filtre icin
  // secilen ownerId/visibility alanlari ayikaniyor.
  const gorunurProjeler = await filterVisibleProjects(org.projects, userId, member.role);

  return {
    ...org,
    projects: gorunurProjeler.map(({ id, name, description, createdAt }) => ({ id, name, description, createdAt })),
    myRole: member.role,
  };
}

export async function updateOrganization(organizationId: string, input: UpdateOrganizationInput, userId: string) {
  const isAdmin = await checkAdmin(organizationId, userId);
  if (!isAdmin) throw new ForbiddenError("Sadece adminler organizasyonu düzenleyebilir");

  const org = await prisma.organization.update({
    where: { id: organizationId },
    data: input,
  });

  return org;
}

export async function deleteOrganization(organizationId: string, userId: string) {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw new NotFoundError("Organizasyon");
  if (org.ownerId !== userId) throw new ForbiddenError("Sadece kurucu organizasyonu silebilir");

  await prisma.organization.delete({ where: { id: organizationId } });
}

// --- DAVET SISTEMI ---
// "Davet et" artik aninda uye yapmiyor: PENDING bir davet olusturuyor,
// karsi taraf bildirimden kabul/reddet secene kadar uye olmuyor.

export async function inviteMember(organizationId: string, input: AddMemberInput, userId: string) {
  const isAdmin = await checkAdmin(organizationId, userId);
  if (!isAdmin) throw new ForbiddenError("Sadece adminler davet gönderebilir");

  const invitedUser = await prisma.user.findUnique({ where: { email: input.email } });
  if (!invitedUser) throw new NotFoundError("Bu email ile kayıtlı kullanıcı bulunamadı");

  const existingMembership = await checkMembership(organizationId, invitedUser.id);
  if (existingMembership) throw new ConflictError("Bu kullanıcı zaten organizasyon üyesi");

  const existingInvite = await prisma.organizationInvitation.findFirst({
    where: { organizationId, invitedUserId: invitedUser.id, status: "PENDING" },
  });
  if (existingInvite) throw new ConflictError("Bu kullanıcıya zaten bekleyen bir davet var");

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw new NotFoundError("Organizasyon");

  const invitation = await prisma.organizationInvitation.create({
    data: {
      organizationId,
      invitedUserId: invitedUser.id,
      invitedById: userId,
      role: (input.role ?? "MEMBER") as Role,
    },
  });

  const inviter = await prisma.user.findUnique({ where: { id: userId } });

  await notificationService.createNotification({
    userId: invitedUser.id,
    type: "ORG_INVITE",
    message: `${inviter?.name ?? "Bir kullanıcı"} sizi "${org.name}" organizasyonuna davet etti`,
    invitationId: invitation.id,
  });

  return invitation;
}

export async function getMyInvitations(userId: string) {
  const invitations = await prisma.organizationInvitation.findMany({
    where: { invitedUserId: userId, status: "PENDING" },
    include: {
      organization: { select: { id: true, name: true } },
      invitedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return invitations;
}

export async function acceptInvitation(invitationId: string, userId: string) {
  const invitation = await prisma.organizationInvitation.findUnique({
    where: { id: invitationId },
    include: { organization: true },
  });
  if (!invitation) throw new NotFoundError("Davet");
  if (invitation.invitedUserId !== userId) throw new ForbiddenError("Bu davet size ait değil");
  if (invitation.status !== "PENDING") throw new ConflictError("Bu davet zaten yanıtlanmış");

  // Yukaridaki status okumasi ile yazma arasinda hicbir kilit yoktu; iki kusuru
  // birden kapatiyoruz. (1) Davet durumu artik KOSULLU guncelleniyor: ayni davete
  // es zamanli iki kez tiklanirsa ikinci istek count===0 alip ConflictError'a
  // dusuyor, uyelik iki kez islenmiyor. (2) Uyelik create yerine upsert ile
  // yaziliyor: ayni kullaniciya iki ayri PENDING davet acilmissa (inviteMember'daki
  // findFirst kontrolu de kontrol-sonra-yaz oldugu icin mumkun) ikinci kabul
  // OrganizationMember'in bilesik anahtarina takilip P2002 -> 500 dondurmuyor ve
  // o davet sonsuza kadar PENDING kalmiyor. Zaten uye olan kisinin rolune
  // dokunulmuyor; rol degistirmek updateMemberRole'un isi.
  const member = await prisma.$transaction(async (tx) => {
    const { count } = await tx.organizationInvitation.updateMany({
      where: { id: invitationId, status: "PENDING" },
      data: { status: "ACCEPTED", respondedAt: new Date() },
    });
    if (count === 0) throw new ConflictError("Bu davet zaten yanıtlanmış");

    return tx.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: invitation.organizationId, userId } },
      create: {
        organizationId: invitation.organizationId,
        userId,
        role: invitation.role,
      },
      update: {},
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  });

  await notificationService.createNotification({
    userId: invitation.invitedById,
    type: "ORG_JOINED",
    message: `${member.user.name}, "${invitation.organization.name}" davetini kabul etti`,
  });

  broadcastToOrganization(invitation.organizationId, SocketEvents.ORG_MEMBER_ADDED, {
    organizationId: invitation.organizationId,
    userId: member.userId,
    userName: member.user.name,
    role: member.role,
    message: `${member.user.name}, "${invitation.organization.name}" organizasyonuna katıldı`,
  });
  return member;
}

// Organizasyonun henuz yanitlanmamis davetlerini goster - admin kime davet
// gonderdigini ve hala bekledigini takip edebilsin
export async function getPendingInvitations(organizationId: string, userId: string) {
  const isAdmin = await checkAdmin(organizationId, userId);
  if (!isAdmin) throw new ForbiddenError("Sadece adminler bekleyen davetleri görebilir");

  return prisma.organizationInvitation.findMany({
    where: { organizationId, status: "PENDING" },
    include: {
      invitedUser: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

// Yanlislikla ya da yanlis email'e gonderilen bekleyen daveti geri al -
// silinince iliskili ORG_INVITE bildirimi de cascade ile kalkar
export async function cancelInvitation(organizationId: string, invitationId: string, userId: string) {
  const isAdmin = await checkAdmin(organizationId, userId);
  if (!isAdmin) throw new ForbiddenError("Sadece adminler daveti geri alabilir");

  const invitation = await prisma.organizationInvitation.findUnique({ where: { id: invitationId } });
  if (!invitation || invitation.organizationId !== organizationId) throw new NotFoundError("Davet");
  if (invitation.status !== "PENDING") throw new ConflictError("Bu davet zaten yanıtlanmış");

  await prisma.organizationInvitation.delete({ where: { id: invitationId } });

  return { cancelled: true };
}

export async function declineInvitation(invitationId: string, userId: string) {
  const invitation = await prisma.organizationInvitation.findUnique({ where: { id: invitationId } });
  if (!invitation) throw new NotFoundError("Davet");
  if (invitation.invitedUserId !== userId) throw new ForbiddenError("Bu davet size ait değil");
  if (invitation.status !== "PENDING") throw new ConflictError("Bu davet zaten yanıtlanmış");

  await prisma.organizationInvitation.update({
    where: { id: invitationId },
    data: { status: "DECLINED", respondedAt: new Date() },
  });

  return { declined: true };
}

// --- ÜYE YÖNETİMİ ---

export async function removeMember(organizationId: string, memberUserId: string, userId: string) {
  const isAdmin = await checkAdmin(organizationId, userId);
  if (!isAdmin) throw new ForbiddenError("Sadece adminler üye çıkarabilir");

  // Kurucu çıkarılamaz
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (org?.ownerId === memberUserId) throw new ForbiddenError("Kurucu organizasyondan çıkarılamaz");

  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: memberUserId } },
    include: { user: { select: { name: true } } },
  });
  if (!member) throw new NotFoundError("Üye");

  // Bildirimi silme işlemi öncesinde gönder
  await notificationService.createNotification({
    userId: memberUserId,
    type: "ORG_REMOVED",
    message: `"${org?.name ?? "Organizasyon"}" organizasyonundan çıkarıldınız`,
  });

  // Emit real-time event
  broadcastToOrganization(organizationId, SocketEvents.ORG_MEMBER_REMOVED, {
    organizationId,
    userId: memberUserId,
    userName: member.user?.name ?? "Bilinmeyen",
    message: `"${org?.name ?? "Organizasyon"}" organizasyonundan çıkarıldı`,
  });

  // Sadece OrganizationMember silmek yetmiyordu: ProjectMember satirlari org
  // uyeligine bagli cascade edilmedigi icin DB'de kaliyor ve kisi ileride
  // (orn. GUEST olarak) tekrar davet edildiginde checkProjectAccess bu eski
  // satirlari bulup PRIVATE projelere erisimi sessizce geri veriyordu. Ayni
  // sekilde bekleyen davetler de artik anlamsiz, temizleniyor. Hepsi tek
  // transaction'da: yarim kalan temizlik ayni acigi birakir.
  await prisma.$transaction(async (tx) => {
    await tx.projectMember.deleteMany({
      where: { userId: memberUserId, project: { organizationId } },
    });

    await tx.organizationInvitation.deleteMany({
      where: { organizationId, invitedUserId: memberUserId, status: "PENDING" },
    });

    await tx.organizationMember.delete({
      where: { organizationId_userId: { organizationId, userId: memberUserId } },
    });
  });

  // Uyelik silinse de kullanicinin ACIK socket'i org/proje odalarinda kaliyordu:
  // odalar yalnizca handshake aninda hesaplandigi icin REST 403 donerken canli
  // kart/yorum/sohbet yayinlari sekme kapanana kadar akmaya devam ediyordu.
  // Tahliye socket.ts'teki ortak yardimciya birakiliyor: org + proje odalarinin
  // yaninda KART odalarini da temizliyor ve socket.organizations/projects
  // dizilerini de guncelliyor (burada elle yazilan surum bunlari atliyordu).
  await evictFromOrganization(organizationId, memberUserId);
}

export async function updateMemberRole(organizationId: string, input: UpdateMemberRoleInput, userId: string) {
  const isAdmin = await checkAdmin(organizationId, userId);
  if (!isAdmin) throw new ForbiddenError("Sadece adminler rol değiştirebilir");

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw new NotFoundError("Organizasyon");

  if (org.ownerId === input.userId) {
    throw new ForbiddenError("Kurucunun rolü değiştirilemez");
  }

  const member = await checkMembership(organizationId, input.userId);
  if (!member) throw new NotFoundError("Üye");

  const updated = await prisma.organizationMember.update({
    where: { organizationId_userId: { organizationId, userId: input.userId } },
    data: { role: input.role as Role },
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
  });

  // Rol DUSURULDUGUNDE de socket odalari bayat kaliyor - uye cikarmadaki
  // ayni kusur. GUEST, gorunurlukten bagimsiz olarak yalnizca ACIKCA
  // eklendigi projeleri gorebilir (bkz. access-control.service); dolayisiyla
  // ADMIN/MEMBER iken otomatik katildigi org ve proje odalarinin cogunda
  // artik bulunmamasi gerekiyor. Tahliye sonrasi istemci hala erisebildigi
  // projelere join:project ile geri girer - o yol her seferinde DB'den
  // dogrulaniyor, yani yalnizca hakki olan odalara donebilir.
  if (member.role !== "GUEST" && input.role === "GUEST") {
    await evictFromOrganization(organizationId, input.userId);
  }

  // Sadece admin yapılınca bildirim git
  if (input.role === "ADMIN") {
    await notificationService.createNotification({
      userId: input.userId,
      type: "ROLE_CHANGED",
      message: `"${org.name}" organizasyonunda yönetici yapıldınız`,
    });
  }

  // Emit real-time event
  broadcastToOrganization(organizationId, SocketEvents.ORG_MEMBER_ROLE_CHANGED, {
    organizationId,
    userId: input.userId,
    userName: updated.user?.name ?? "Bilinmeyen",
    role: input.role,
    message: `"${org.name}" organizasyonunda rolü değiştirildi: ${input.role}`,
  });

  return updated;
}
