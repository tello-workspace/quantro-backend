const fs = require('fs');
let logBuffer = [];
function log(msg) {
  console.log(msg);
  logBuffer.push(msg);
}

async function run() {
  const BASE_URL = 'http://localhost:3001/api';

  log('1. Logging in as admin@tello.demo...');
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@tello.demo', password: 'demo1234' })
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  }

  const loginData = await loginRes.json();
  const token = loginData.data?.token || loginData.token;
  if (!token) {
    throw new Error(`No token returned: ${JSON.stringify(loginData)}`);
  }
  log('Login successful! Token acquired.');

  log('\n2. Fetching projects...');
  const projectsRes = await fetch(`${BASE_URL}/projects`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!projectsRes.ok) {
    throw new Error(`Fetching projects failed: ${projectsRes.status} ${await projectsRes.text()}`);
  }

  const projectsData = await projectsRes.json();
  const projects = projectsData.data || projectsData;
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error(`No projects found: ${JSON.stringify(projectsData)}`);
  }

  const project = projects[0];
  log(`Found project: "${project.name}" (ID: ${project.id})`);

  log('\n3. Fetching board columns to find a column ID...');
  const columnsRes = await fetch(`${BASE_URL}/columns?projectId=${project.id}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!columnsRes.ok) {
    throw new Error(`Fetching columns failed: ${columnsRes.status} ${await columnsRes.text()}`);
  }
  const columnsData = await columnsRes.json();
  const columns = columnsData.data || columnsData;
  log(`Found columns: ${columns.map(c => `"${c.name}" (ID: ${c.id})`).join(', ')}`);

  const todoColumn = columns.find(c => c.name.toLowerCase() === 'to do') || columns[0];
  log(`Using target column: "${todoColumn.name}" (ID: ${todoColumn.id})`);

  log('\n4. Sending AI message to create a card...');
  const messageContent = `create_card tool'unu kullanarak "${todoColumn.id}" kolonuna "Test Card from AI" başlıklı bir kart ekler misin?`;
  log(`User prompt: "${messageContent}"`);
  
  const chatRes = await fetch(`${BASE_URL}/ai/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      projectId: project.id,
      messages: [{ role: 'user', content: messageContent }]
    })
  });

  if (!chatRes.ok) {
    throw new Error(`AI Chat failed: ${chatRes.status} ${await chatRes.text()}`);
  }

  const chatData = await chatRes.json();
  log('\nAI Response:');
  log(chatData.data?.reply || chatData.reply || JSON.stringify(chatData));
}

run()
  .then(() => {
    log('Script completed successfully.');
    fs.writeFileSync('test_run_log.txt', logBuffer.join('\n'), 'utf8');
  })
  .catch((err) => {
    log(`ERROR: ${err.message}\nStack: ${err.stack}`);
    fs.writeFileSync('test_run_log.txt', logBuffer.join('\n'), 'utf8');
    process.exit(1);
  });

