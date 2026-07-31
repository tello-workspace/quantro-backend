const io = require("socket.io-client");
const http = require("http");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

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
  // 1. Clean up old invitations for can@quantro.demo to prevent ConflictError
  const can = await prisma.user.findFirst({ where: { email: "can@quantro.demo" } });
  const admin = await prisma.user.findFirst({ where: { email: "admin@quantro.demo" } });
  const org = await prisma.organization.findFirst({ where: { name: "Quantro Demo" } });
  
  if (can && org) {
    // Delete any notifications first due to foreign key constraints
    await prisma.notification.deleteMany({
      where: { userId: can.id }
    });
    // Delete invitations
    await prisma.organizationInvitation.deleteMany({
      where: { organizationId: org.id, invitedUserId: can.id }
    });
    console.log("Cleaned up previous invitations and notifications for can@quantro.demo");
  }

  console.log("2. Logging in as admin...");
  const loginResult = await makeRequest("/api/auth/login", "POST", "", {
    email: "admin@quantro.demo",
    password: "demo1234",
  });
  const token = loginResult.data?.token || loginResult.token;
  console.log("Logged in! Token acquired:", token.substring(0, 10) + "...");

  // Also log in as can@quantro.demo so we can listen to their socket!
  const canLoginResult = await makeRequest("/api/auth/login", "POST", "", {
    email: "can@quantro.demo",
    password: "demo1234",
  });
  const canToken = canLoginResult.data?.token || canLoginResult.token;

  console.log("3. Connecting Can't socket to listen for notifications...");
  const socketUrl = "http://localhost:3001";
  const canSocket = io(socketUrl, {
    path: "/socket.io",
    transports: ["polling", "websocket"],
    auth: { token: canToken },
  });

  canSocket.on("connect", () => {
    console.log("Can's Socket connected! ID:", canSocket.id);
  });

  canSocket.on("authenticated", (user) => {
    console.log("Can's Socket authenticated as:", user.name);
    
    // Now trigger the invitation from Admin
    triggerInvite(token, org.id);
  });

  canSocket.on("notification:new", (notification) => {
    console.log("[CAN RECEIVED notification:new]", notification.id, notification.message);
  });

  // Keep script alive for 5 seconds to capture events
  setTimeout(() => {
    canSocket.disconnect();
    prisma.$disconnect();
    console.log("Test finished.");
    process.exit(0);
  }, 5000);
}

async function triggerInvite(token, orgId) {
  console.log("Sending invitation to can@quantro.demo...");
  const inviteResult = await makeRequest(`/api/organizations/${orgId}/members`, "POST", token, {
    email: "can@quantro.demo",
    role: "MEMBER"
  });
  console.log("Invite API result:", inviteResult);
}

main().catch(console.error);
