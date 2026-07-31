const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const http = require("http");

function makeRequest(path, method, token, bodyData) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyData ? JSON.stringify(bodyData) : "";
    const headers = {
      "Authorization": `Bearer ${token}`,
    };
    if (bodyStr) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname: "localhost",
      port: 3001,
      path: path,
      method: method,
      headers: headers,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on("error", (e) => {
      reject(e);
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

async function main() {
  console.log("1. Logging in as admin@quantro.demo...");
  const loginResult = await makeRequest("/api/auth/login", "POST", "", {
    email: "admin@quantro.demo",
    password: "demo1234",
  });
  const token = loginResult.data?.token || loginResult.token;

  // Let's find the organization "Quantro Demo"
  const org = await prisma.organization.findFirst({ where: { name: "Quantro Demo" } });
  if (!org) {
    console.error("Quantro Demo organization not found");
    return;
  }

  // Let's find the project under Quantro Demo
  const project = await prisma.project.findFirst({
    where: { name: "E-Ticaret Yenileme", organizationId: org.id }
  });
  if (!project) {
    console.error("Project not found under Quantro Demo");
    return;
  }

  const columns = await prisma.column.findMany({ where: { projectId: project.id } });
  console.log("Columns:", columns.map(c => `${c.name} (${c.id})`));

  // Find any card under these columns
  const card = await prisma.card.findFirst({
    where: { columnId: { in: columns.map(c => c.id) } },
    include: { column: true }
  });
  if (!card) {
    console.error("No card found in Quantro Demo project");
    return;
  }

  const otherColumn = columns.find(c => c.id !== card.columnId);
  if (!otherColumn) {
    console.error("No other column found");
    return;
  }

  console.log(`Moving card "${card.title}" (ID: ${card.id}) from column "${card.column.name}" to "${otherColumn.name}"...`);
  // Move card
  const moveResult = await makeRequest(`/api/cards/${card.id}`, "PATCH", token, {
    columnId: otherColumn.id,
    position: card.position
  });

  console.log("Move result:", moveResult);
  prisma.$disconnect();
}

main().catch(console.error);
