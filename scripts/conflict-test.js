// "Git Cakismasi Erken Uyari" ozelligi icin uctan uca manuel test scripti.
//
// Iki farkli kullanici token'iyla iki socket acar, ayni dosya yolunda FARKLI
// kartlarla `presence:file` gonderir ve `conflict:detected` eventinin her iki
// tarafa da dustugunu gosterir. Gercek VSCode extension'ini taklit eder, yani
// sunum sirasinda iki ayri VSCode penceresi acmaya gerek kalmaz.
//
// Kullanim:
//   npm run test:conflict
//
// Varsayilan olarak seed verisindeki demo kullanicilarini kullanir
// (bkz. prisma/seed.ts -> `npm run db:seed`):
//   mehmet@tello.demo / demo1234  ve  zeynep@tello.demo / demo1234
//
// Kendi kullanicilarinla test etmek icin env degiskenleriyle override et:
//   USER_A_EMAIL, USER_A_PASSWORD, USER_B_EMAIL, USER_B_PASSWORD
//   TELLO_API_URL   (varsayilan http://localhost:4000/api)
//   TEST_FILE_PATH  (varsayilan src/server/socket.ts)
//
// ONKOSUL: Backend ayakta olmali (`npm run dev`) ve iki kullanici da AYNI
// organizasyon + AYNI projede olmali; o projede en az 2 kart bulunmali.
//
// NOT: `npm run dev` watch modunda calismaz. socket.ts'i degistirdiysen
// sunucuyu yeniden baslatmadan test etme — eski kod bellekte kalir ve
// `presence:file` eventi sessizce yok sayilir.

const { io } = require('socket.io-client');

const API_URL = process.env.TELLO_API_URL || 'http://localhost:4000/api';
const SOCKET_URL = process.env.TELLO_SOCKET_URL || API_URL.replace(/\/api\/?$/, '');
const TEST_FILE_PATH = process.env.TEST_FILE_PATH || 'src/server/socket.ts';

const USER_A = {
  email: process.env.USER_A_EMAIL || 'mehmet@tello.demo',
  password: process.env.USER_A_PASSWORD || 'demo1234',
};
const USER_B = {
  email: process.env.USER_B_EMAIL || 'zeynep@tello.demo',
  password: process.env.USER_B_PASSWORD || 'demo1234',
};

async function login(user) {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user),
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(`Giris basarisiz (${user.email}): ${json.error?.message || JSON.stringify(json)}`);
  }
  return { token: json.data.token, name: json.data.user.name };
}

async function getTwoCards(token) {
  const orgsRes = await fetch(`${API_URL}/organizations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const orgsJson = await orgsRes.json();
  const org = orgsJson.data?.[0];
  if (!org) throw new Error('Bu kullanicinin hicbir organizasyonu yok.');

  const projectsRes = await fetch(`${API_URL}/organizations/${org.id}/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const projectsJson = await projectsRes.json();
  const project = projectsJson.data?.[0];
  if (!project) throw new Error(`"${org.name}" organizasyonunda hicbir proje yok.`);

  const boardRes = await fetch(`${API_URL}/projects/${project.id}/board`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const boardJson = await boardRes.json();
  const tasks = Object.values(boardJson.data?.tasks || {});
  if (tasks.length < 2) {
    throw new Error(`"${project.name}" projesinde en az 2 kart olmali (su an ${tasks.length}).`);
  }

  return {
    orgName: org.name,
    projectName: project.name,
    cardA: { id: tasks[0].id, title: tasks[0].title },
    cardB: { id: tasks[1].id, title: tasks[1].title },
  };
}

function connectSocket(token, label) {
  return new Promise((resolve, reject) => {
    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      console.log(`   [${label}] socket bagli (${socket.id})`);
      resolve(socket);
    });

    socket.on('connect_error', (err) => {
      reject(new Error(`[${label}] socket baglanti hatasi: ${err.message}`));
    });

    socket.on('conflict:detected', (payload) => {
      console.log(`\n[!] [${label}] conflict:detected alindi:`);
      console.log(JSON.stringify(payload, null, 2));
    });

    socket.on('conflict:resolved', (payload) => {
      console.log(`\n[ok] [${label}] conflict:resolved alindi:`);
      console.log(JSON.stringify(payload, null, 2));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`Backend: ${API_URL}\n`);

  console.log('1) Iki kullaniciyla giris yapiliyor...');
  const [a, b] = await Promise.all([login(USER_A), login(USER_B)]);
  console.log(`   A = ${USER_A.email} (${a.name})`);
  console.log(`   B = ${USER_B.email} (${b.name})`);

  console.log('\n2) Ortak proje/kart bilgisi cekiliyor (A uzerinden)...');
  const { orgName, projectName, cardA, cardB } = await getTwoCards(a.token);
  console.log(`   Org: ${orgName} | Proje: ${projectName}`);
  console.log(`   Kart A: "${cardA.title}" (${cardA.id})`);
  console.log(`   Kart B: "${cardB.title}" (${cardB.id})`);

  console.log('\n3) Socketler baglaniyor...');
  const [socketA, socketB] = await Promise.all([
    connectSocket(a.token, 'A'),
    connectSocket(b.token, 'B'),
  ]);

  await sleep(1000);

  console.log(`\n4) A -> presence:file  { cardId: ${cardA.id}, filePath: "${TEST_FILE_PATH}" }  (henuz cakisma yok, tek kisi var)`);
  socketA.emit('presence:file', { cardId: cardA.id, filePath: TEST_FILE_PATH });

  await sleep(1000);

  console.log(`5) B -> presence:file  { cardId: ${cardB.id}, filePath: "${TEST_FILE_PATH}" }  (AYNI dosya, FARKLI kart -> cakisma beklenir)\n`);
  socketB.emit('presence:file', { cardId: cardB.id, filePath: TEST_FILE_PATH });

  await sleep(2500);

  console.log(`\n6) B baska bir dosyaya geciyor -> cakisma cozulmeli (conflict:resolved beklenir)\n`);
  socketB.emit('presence:file', { cardId: cardB.id, filePath: 'src/lib/prisma.ts' });

  await sleep(2500);

  console.log('\n--- Ozet ---');
  console.log('Beklenen: 5. adimdan sonra iki tarafta da "conflict:detected",');
  console.log('6. adimdan sonra iki tarafta da "conflict:resolved" bloklari.');
  console.log('Gorunmuyorsa: backend degisiklikten sonra yeniden baslatildi mi?');
  socketA.disconnect();
  socketB.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('\nHATA:', err.message);
  process.exit(1);
});
