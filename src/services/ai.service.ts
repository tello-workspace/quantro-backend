import { prisma } from "@/lib/prisma";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AIProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function getProvider(): AIProvider {
  return {
    baseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.AI_API_KEY || "",
    model: process.env.AI_MODEL || "gpt-3.5-turbo",
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

export async function sendMessage(
  projectId: string,
  userId: string,
  messages: ChatMessage[],
): Promise<string> {
  const provider = getProvider();

  if (!provider.apiKey) {
    // API key yoksa demo/fallback cevap döndür
    return "⚠️ AI asistanı yapılandırılmamış. Lütfen yöneticinizle iletişime geçin.\n\n(.env dosyasında AI_API_KEY, AI_BASE_URL ve AI_MODEL değişkenlerini ayarlayın.)";
  }

  // Proje bilgilerini al
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });

  const boardContext = await getBoardContext(projectId);
  const systemPrompt = buildSystemPrompt(project?.name || "Proje", boardContext);

  // Mevcut mesaj geçmişinin son 20 mesajını kullan, başa system mesajını ekle
  const recentMessages = messages.slice(-20);
  const apiMessages = [
    { role: "system" as const, content: systemPrompt },
    ...recentMessages.filter((m) => m.role !== "system"),
  ];

  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: apiMessages,
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("[AI] API hatası:", response.status, errorBody);
      return `⚠️ AI servisi şu anda kullanılamıyor. (Hata: ${response.status})`;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return "⚠️ AI asistanı boş cevap döndü.";
    }

    return content;
  } catch (error) {
    console.error("[AI] İstek hatası:", error);
    return "⚠️ AI servisine bağlanırken bir hata oluştu.";
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

  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: "Sen bir proje yönetimi danışmanısın." },
          { role: "user", content: prompt },
        ],
        max_tokens: 512,
        temperature: 0.5,
      }),
    });

    if (!response.ok) return "";
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  } catch {
    return "";
  }
}
