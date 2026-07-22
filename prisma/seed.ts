import { PrismaClient, Priority } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const SALT_ROUNDS = 10;
const DAY = 24 * 60 * 60 * 1000;
const now = () => new Date();
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY);

const DEMO_ORG_NAME = "Tello Demo";
const DEMO_EMAILS = [
  "admin@tello.demo",
  "mehmet@tello.demo",
  "zeynep@tello.demo",
  "can@tello.demo",
];

// Demo verisini tekrar tekrar `npm run db:seed` calistirilsa bile temiz
// birakmak icin: onceki demo organizasyonunu ve kullanicilarini sil.
// Organization once silinir - Project/Column/Card/Label/Member/Invitation
// hepsi ona cascade bagli. Kullanicilar ancak ondan sonra silinebilir
// (Comment.author / Card.creator gibi bazi iliskiler cascade degil).
async function cleanupPreviousSeed() {
  await prisma.organization.deleteMany({ where: { name: DEMO_ORG_NAME } });
  await prisma.user.deleteMany({ where: { email: { in: DEMO_EMAILS } } });
}

async function main() {
  console.log("🌱 Seed data...");

  await cleanupPreviousSeed();

  const passwordHash = await bcrypt.hash("demo1234", SALT_ROUNDS);

  const admin = await prisma.user.create({
    data: { name: "Ayşe Yılmaz", email: "admin@tello.demo", passwordHash },
  });
  const mehmet = await prisma.user.create({
    data: { name: "Mehmet Kaya", email: "mehmet@tello.demo", passwordHash },
  });
  const zeynep = await prisma.user.create({
    data: { name: "Zeynep Demir", email: "zeynep@tello.demo", passwordHash },
  });
  // Henuz organizasyona katilmamis - bekleyen davet akisini gostermek icin
  const can = await prisma.user.create({
    data: { name: "Can Öztürk", email: "can@tello.demo", passwordHash },
  });

  const org = await prisma.organization.create({
    data: {
      name: DEMO_ORG_NAME,
      description: "Örnek veri seti - staj sunumu için",
      ownerId: admin.id,
      members: {
        create: [
          { userId: admin.id, role: "ADMIN" },
          { userId: mehmet.id, role: "MEMBER" },
          { userId: zeynep.id, role: "MEMBER" },
        ],
      },
    },
  });

  await prisma.organizationInvitation.create({
    data: {
      organizationId: org.id,
      invitedUserId: can.id,
      invitedById: admin.id,
      role: "MEMBER",
    },
  });

  const project = await prisma.project.create({
    data: {
      name: "E-Ticaret Yenileme",
      description: "Mağaza altyapısının modernizasyonu",
      organizationId: org.id,
      ownerId: admin.id,
    },
  });

  const [todo, inProgress, review, done] = await Promise.all([
    prisma.column.create({ data: { projectId: project.id, name: "To Do", position: 1 } }),
    prisma.column.create({ data: { projectId: project.id, name: "In Progress", position: 2, wipLimit: 3 } }),
    prisma.column.create({ data: { projectId: project.id, name: "Review", position: 3 } }),
    prisma.column.create({ data: { projectId: project.id, name: "Done", position: 4, isDone: true } }),
  ]);

  const [labelBug, labelDesign] = await Promise.all([
    prisma.label.create({ data: { projectId: project.id, name: "Bug", color: "#EF4444" } }),
    prisma.label.create({ data: { projectId: project.id, name: "Tasarım", color: "#8B5CF6" } }),
  ]);

  // --- To Do ---
  const card1 = await prisma.card.create({
    data: {
      columnId: todo.id,
      title: "Ödeme sağlayıcı entegrasyonu",
      description: "Stripe ile ödeme akışının bağlanması",
      creatorId: admin.id,
      priority: Priority.MEDIUM,
      dueDate: daysFromNow(10),
      position: 1,
      createdAt: daysAgo(1),
      lastActivityAt: daysAgo(1),
      assignees: { create: [{ userId: mehmet.id }] },
    },
  });

  await prisma.card.create({
    data: {
      columnId: todo.id,
      title: "Mobil uyum testleri",
      creatorId: admin.id,
      priority: Priority.LOW,
      position: 2,
      createdAt: daysAgo(2),
      lastActivityAt: daysAgo(2),
      assignees: { create: [{ userId: mehmet.id }] },
    },
  });

  // --- In Progress (wipLimit=3, 4 kart konularak darboğaz demo edilir) ---
  const card3 = await prisma.card.create({
    data: {
      columnId: inProgress.id,
      title: "Sepet sayfası yeniden tasarımı",
      creatorId: admin.id,
      priority: Priority.HIGH,
      dueDate: daysFromNow(5),
      position: 1,
      createdAt: daysAgo(3),
      lastActivityAt: daysAgo(1),
      assignees: { create: [{ userId: zeynep.id }] },
      labels: { create: [{ labelId: labelDesign.id }] },
    },
  });

  await prisma.card.create({
    data: {
      columnId: inProgress.id,
      title: "Ürün arama performansı",
      creatorId: admin.id,
      priority: Priority.URGENT,
      dueDate: daysFromNow(7),
      position: 2,
      createdAt: daysAgo(4),
      lastActivityAt: now(),
      assignees: { create: [{ userId: mehmet.id }] },
    },
  });

  // Stale + deadline risk: 10 gündür hareketsiz, teslim tarihi 2 gün sonra
  const card5 = await prisma.card.create({
    data: {
      columnId: inProgress.id,
      title: "Checkout hata ayıklama",
      description: "Ödeme sonrası sipariş oluşturulmuyor",
      creatorId: admin.id,
      priority: Priority.URGENT,
      dueDate: daysFromNow(2),
      position: 3,
      createdAt: daysAgo(20),
      lastActivityAt: daysAgo(10),
      assignees: { create: [{ userId: mehmet.id }] },
      labels: { create: [{ labelId: labelBug.id }] },
    },
  });

  // Cok stale (14+ gun) - kart uzerinde kirmizi kenar demo
  await prisma.card.create({
    data: {
      columnId: inProgress.id,
      title: "Envanter senkronizasyonu",
      creatorId: admin.id,
      priority: Priority.HIGH,
      position: 4,
      createdAt: daysAgo(30),
      lastActivityAt: daysAgo(16),
      assignees: { create: [{ userId: mehmet.id }] },
      labels: { create: [{ labelId: labelBug.id }] },
    },
  });

  // --- Review ---
  const card7 = await prisma.card.create({
    data: {
      columnId: review.id,
      title: "Ödeme akışı QA",
      creatorId: admin.id,
      priority: Priority.MEDIUM,
      dueDate: daysFromNow(14),
      position: 1,
      createdAt: daysAgo(5),
      lastActivityAt: daysAgo(2),
      assignees: { create: [{ userId: zeynep.id }] },
    },
  });

  // Bağımlılık: checkout hatası çözülmeden QA başlayamaz
  await prisma.cardDependency.create({
    data: { blockerId: card5.id, blockedId: card7.id },
  });

  // --- Done (bu hafta tamamlanan kartlar - haftalık özet demo) ---
  const card8 = await prisma.card.create({
    data: {
      columnId: done.id,
      title: "Login sayfası tasarımı",
      creatorId: admin.id,
      priority: Priority.MEDIUM,
      position: 1,
      createdAt: daysAgo(15),
      updatedAt: daysAgo(2),
      lastActivityAt: daysAgo(2),
      assignees: { create: [{ userId: zeynep.id }] },
    },
  });

  const card9 = await prisma.card.create({
    data: {
      columnId: done.id,
      title: "Header/Footer bileşenleri",
      creatorId: admin.id,
      priority: Priority.LOW,
      position: 2,
      createdAt: daysAgo(25),
      updatedAt: daysAgo(4),
      lastActivityAt: daysAgo(4),
      assignees: { create: [{ userId: mehmet.id }] },
    },
  });

  await prisma.comment.createMany({
    data: [
      { cardId: card3.id, authorId: admin.id, text: "Figma tasarımı ekte, buna göre ilerleyelim." },
      { cardId: card5.id, authorId: mehmet.id, text: "Sorunu üretim ortamında yeniden oluşturabildim, kök nedeni araştırıyorum." },
      { cardId: card1.id, authorId: mehmet.id, text: "Stripe test anahtarları .env'e eklendi." },
    ],
  });

  // Aktivite akışı demosu - normalde bu kayıtlar card/comment/dependency
  // servisleri her mutasyonda kendiliğinden oluşturur, burada elle giriyoruz
  await prisma.activity.createMany({
    data: [
      { projectId: project.id, userId: admin.id, cardId: card1.id, type: "CARD_CREATED", createdAt: daysAgo(1) },
      {
        projectId: project.id,
        userId: admin.id,
        cardId: card3.id,
        type: "CARD_MOVED",
        data: { from: "To Do", to: "In Progress" },
        createdAt: daysAgo(3),
      },
      {
        projectId: project.id,
        userId: admin.id,
        cardId: card5.id,
        type: "CARD_ASSIGNED",
        data: { assignedTo: [mehmet.name] },
        createdAt: daysAgo(20),
      },
      { projectId: project.id, userId: mehmet.id, cardId: card1.id, type: "COMMENT_ADDED", data: { preview: "Stripe test anahtarları .env'e eklendi." }, createdAt: daysAgo(1) },
      { projectId: project.id, userId: admin.id, cardId: card3.id, type: "COMMENT_ADDED", data: { preview: "Figma tasarımı ekte, buna göre ilerleyelim." }, createdAt: daysAgo(3) },
      { projectId: project.id, userId: mehmet.id, cardId: card5.id, type: "COMMENT_ADDED", data: { preview: "Sorunu üretim ortamında yeniden oluşturabildim." }, createdAt: daysAgo(10) },
      {
        projectId: project.id,
        userId: admin.id,
        cardId: card7.id,
        type: "DEPENDENCY_ADDED",
        data: { blockerTitle: card5.title, blockedTitle: card7.title },
        createdAt: daysAgo(5),
      },
      { projectId: project.id, userId: zeynep.id, cardId: card8.id, type: "CARD_COMPLETED", createdAt: daysAgo(2) },
      { projectId: project.id, userId: mehmet.id, cardId: card9.id, type: "CARD_COMPLETED", createdAt: daysAgo(4) },
    ],
  });

  await prisma.notification.create({
    data: {
      userId: mehmet.id,
      cardId: card1.id,
      type: "ASSIGNED",
      message: `"${card1.title}" kartı size atandı`,
    },
  });

  const invitation = await prisma.organizationInvitation.findFirstOrThrow({
    where: { organizationId: org.id, invitedUserId: can.id },
  });
  await prisma.notification.create({
    data: {
      userId: can.id,
      invitationId: invitation.id,
      type: "ORG_INVITE",
      message: `${admin.name} sizi "${org.name}" organizasyonuna davet etti`,
    },
  });

  console.log("✅ Demo veri oluşturuldu:");
  console.log("   admin@tello.demo / demo1234  (ADMIN - Ayşe Yılmaz)");
  console.log("   mehmet@tello.demo / demo1234 (MEMBER - Mehmet Kaya, aşırı yüklü)");
  console.log("   zeynep@tello.demo / demo1234 (MEMBER - Zeynep Demir)");
  console.log("   can@tello.demo / demo1234    (henüz üye değil - bekleyen davet)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
