const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true }
  });
  console.log("USERS:");
  console.log(users);

  const orgs = await prisma.organization.findMany({
    include: {
      members: { include: { user: { select: { email: true } } } },
      projects: true
    }
  });

  console.log("\nORGANIZATIONS & PROJECTS:");
  for (const org of orgs) {
    console.log(`- Org: ${org.name} (ID: ${org.id})`);
    console.log("  Members:", org.members.map(m => `${m.user.email} (${m.role})`).join(", "));
    console.log("  Projects:");
    for (const proj of org.projects) {
      console.log(`    * Project: ${proj.name} (ID: ${proj.id})`);
    }
  }

  prisma.$disconnect();
}

main().catch(console.error);
