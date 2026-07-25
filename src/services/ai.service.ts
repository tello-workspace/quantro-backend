import { prisma } from "@/lib/prisma";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AIProvider {
  provider: "openai" | "google-gemini";
  baseUrl: string;
  apiKey: string;
  model: string;
}

function getProvider(): AIProvider {
  const provider = (process.env.AI_PROVIDER || "openai") as AIProvider["provider"];
  const apiKey = process.env.AI_API_KEY || "";

  if (provider === "google-gemini") {
    return {
      provider: "google-gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey,
      model: process.env.AI_MODEL || "gemini-1.5-flash",
    };
  }

  // Default: OpenAI-compatible
  return {
    provider: "openai",
    baseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
    apiKey,
    model: process.env.AI_MODEL || "gpt-4o-mini",
  };
}

function buildSystemPrompt(projectName: string, boardContext: string): string {
  return `Sen bir Trello benzeri bir proje yönetim uygulamasının AI asistanısın.
Kullanıcılara proje yönetimi, kart organize etme, iş akışı optimizasyonu konularında yardımcı oluyorsun.

Mevcut proje: "${projectName}"

Proje panosundaki mevcut durum:
${boardContext}

Kullanıcılara kısa, net ve Türkçe cevap ver. Kart ekleme, taşıma, düzenleme gibi işlemleri yapamazsın, sadece tavsiye verirsin ve soruları cevaplarsın.`;
}

async function getBoardContext(projectId: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      columns: {
        orderBy: { position: "asc" },
        include: {
          cards: {
            include: {
              assignees: { include: { user: { select: { name: true } } } },
              labels: { include: { label: { select: { name: true, color: true } } } },
            },
          },
        },
      },
    },
  });

  if (!project) return "";

  const parts: string[] = [];
  for (const col of project.columns) {
    const cardCount = col.cards.length;
    const cardList = col.cards
      .slice(0, 20)
      .map((c) => {
        let info = `    - "${c.title}"`;
        if (c.dueDate) info += ` (bitiş: ${new Date(c.dueDate).toLocaleDateString("tr-TR")})`;
        if (c.assignees.length) info += ` [${c.assignees.map((a) => a.user.name).join(", ")}]`;
        if (c.labels.length) info += ` etiket: ${c.labels.map((l) => l.label.name).join(", ")}`;
        return info;
      })
      .join("\n");

    parts.push(`Sütun: ${col.name} (${cardCount} kart)${cardList ? `\n${cardList}` : ""}`);
  }

  return parts.join("\n\n");
}

async function callOpenAI(provider: AIProvider, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    }),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[AI] OpenAI API hatası:", response.status, errorBody);
    if (response.status === 401) return "⚠️ API anahtarı geçersiz. Lütfen yöneticinizle iletişime geçin.";
    if (response.status === 429) return "⚠️ Çok fazla istek gönderildi. Lütfen biraz bekleyip tekrar deneyin.";
    return `⚠️ AI servisi şu anda kullanılamıyor. (Hata: ${response.status})`;
  }

  // Bazı modeller (UwU gibi) JSON sonunda "data: [DONE]" SSE eki gönderebilir
  let raw = await response.text();
  raw = raw.replace(/\n?data:\s*\[DONE\]\s*$/i, "").trim();

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("[AI] JSON parse hatası, raw:", raw.slice(0, 500));
    return "⚠️ AI servisinden geçersiz yanıt alındı.";
  }

  const choices = (data as any).choices;
  const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
  const content = msg?.content || msg?.reasoning_content || "";
  if (typeof content !== "string" || !content.trim()) {
    return "⚠️ AI asistanı boş cevap döndü.";
  }

  return content;
}

async function callGemini(provider: AIProvider, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  // OpenAI mesaj formatını Gemini'ye çevir
  const contents: { role: string; parts: { text: string }[] }[] = [];
  let systemInstruction = "";

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction += (systemInstruction ? "\n" : "") + msg.content;
      continue;
    }
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    });
  }

  const body: Record<string, unknown> = { contents };
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] };
  }

  const url = `${provider.baseUrl}/models/${provider.model}:generateContent?key=${provider.apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[AI] Gemini API hatası:", response.status, errorBody);
    if (response.status === 400) return "⚠️ İstek formatı geçersiz.";
    if (response.status === 403) return "⚠️ API anahtarı geçersiz veya yetkisiz.";
    return `⚠️ AI servisi şu anda kullanılamıyor. (Hata: ${response.status})`;
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) return "⚠️ AI asistanı boş cevap döndü.";

  return content;
}

export async function sendMessage(
  projectId: string,
  _userId: string,
  messages: ChatMessage[],
): Promise<string> {
  const provider = getProvider();

  if (!provider.apiKey) {
    return "⚠️ AI asistanı yapılandırılmamış. Lütfen yöneticinizle iletişime geçin.\n\n(.env dosyasında AI_API_KEY ve AI_PROVIDER değişkenlerini ayarlayın.)";
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });

  const boardContext = await getBoardContext(projectId);
  const systemPrompt = buildSystemPrompt(project?.name || "Proje", boardContext);

  const recentMessages = messages.slice(-20);
  const apiMessages = [
    { role: "system" as const, content: systemPrompt },
    ...recentMessages.filter((m) => m.role !== "system"),
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    if (provider.provider === "google-gemini") {
      return await callGemini(provider, apiMessages, controller.signal);
    }
    return await callOpenAI(provider, apiMessages, controller.signal);
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return "⚠️ AI servisi zaman aşımına uğradı. Lütfen daha kısa mesajlarla tekrar deneyin.";
    }
    console.error("[AI] İstek hatası:", error);
    return "⚠️ AI servisine bağlanırken bir hata oluştu.";
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateProjectInsights(
  projectId: string,
): Promise<string> {
  const provider = getProvider();
  if (!provider.apiKey) return "";

  const boardContext = await getBoardContext(projectId);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });

  const prompt = `Sen bir proje yönetimi danışmanısın. Aşağıdaki proje panosunu analiz edip 3-5 maddelik kısa bir içgörü raporu hazırla:

Proje: ${project?.name || "Bilinmeyen"}

${boardContext}

Dikkat edilmesi gereken noktalar:
- Çok uzun süredir aynı sütunda bekleyen kartlar
- Aşırı yüklenmiş kişiler
- Yaklaşan deadline'lar
- WIP limiti aşımları
- İyileştirme önerileri

Kısa ve net Türkçe cevap ver.`;

  const messages: ChatMessage[] = [
    { role: "system", content: "Sen bir proje yönetimi danışmanısın." },
    { role: "user", content: prompt },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    if (provider.provider === "google-gemini") {
      return await callGemini(provider, messages, controller.signal);
    }
    return await callOpenAI(provider, messages, controller.signal);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}
