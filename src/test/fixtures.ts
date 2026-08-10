import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { allocateCardNumber } from "@/services/card-key.service";

// Testler paylasilan uzak DB'ye baglandigi icin her kayit benzersiz bir
// eke sahip olur; boylece paralel/tekrarli kosumlar birbirini bozmaz ve
// temizlik sadece o kosumun verisini siler.
export const TEST_TAG = "__tello_test__";

export function uniq(prefix: string): string {
  return `${prefix}-${TEST_TAG}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createUser(name = "Test User") {
  const passwordHash = await bcrypt.hash("test1234", 4);
  // emailVerifiedAt varsayilan olarak doldurulur: bu fixture "zaten var olan,
  // onboard edilmis" bir kullaniciyi temsil ediyor - kayit/dogrulama akisinin
  // kendisini test eden email-verification.test.ts disindaki tum testler
  // (permissions, search, attachments vb.) login/yetki davranisini test
  // ederken dogrulama adimiyla ugrasmak istemiyor.
  return prisma.user.create({
    data: { name, email: `${uniq("user")}@example.com`, passwordHash, emailVerifiedAt: new Date() },
  });
}

// Admin + uye + proje + To Do/Bitti sutunlari iceren hazir bir kurulum.
export async function createWorkspace() {
  const admin = await createUser("Admin User");
  const member = await createUser("Member User");
  const outsider = await createUser("Outsider User");

  const org = await prisma.organization.create({
    data: {
      name: uniq("org"),
      ownerId: admin.id,
      members: {
        create: [
          { userId: admin.id, role: "ADMIN" },
          { userId: member.id, role: "MEMBER" },
        ],
      },
    },
  });

  // Kart anahtari oneki (QNT-42'nin QNT'si). Testler ayni org'da tek proje
  // kullaniyor; benzersizlik org bazinda oldugu icin sabit "TST" yeterli.
  // Ikinci bir proje acan testler kendi anahtarini vermeli.
  const project = await prisma.project.create({
    data: { name: uniq("project"), key: "TST", organizationId: org.id, ownerId: admin.id },
  });

  const todo = await prisma.column.create({
    data: { projectId: project.id, name: "To Do", position: 1 },
  });
  const done = await prisma.column.create({
    data: { projectId: project.id, name: "Bitti", position: 2, isDone: true },
  });

  return { admin, member, outsider, org, project, todo, done };
}

export async function createCard(columnId: string, creatorId: string, title = "Test Card") {
  // Kart numarasi servis katmaninda Project.cardCounter'dan aliniyor; bu
  // fixture servisi atlayip dogrudan yazdigi icin sayaci burada da
  // ilerletiyoruz - aksi halde ayni projede iki fixture karti ayni numarayi
  // alir ve "QNT-1" iki karti gosterirdi.
  const column = await prisma.column.findUniqueOrThrow({
    where: { id: columnId },
    select: { projectId: true },
  });
  const number = await allocateCardNumber(column.projectId);

  return prisma.card.create({
    data: { columnId, number, title, creatorId, position: 1 },
  });
}

// Org silinince project/column/card/member zincirleme siliniyor (onDelete: Cascade).
export async function cleanup(ids: { orgIds?: string[]; userIds?: string[] }) {
  if (ids.orgIds?.length) {
    await prisma.organization.deleteMany({ where: { id: { in: ids.orgIds } } });
  }
  if (ids.userIds?.length) {
    await prisma.user.deleteMany({ where: { id: { in: ids.userIds } } });
  }
}
