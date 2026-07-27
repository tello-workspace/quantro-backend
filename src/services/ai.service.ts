import { prisma } from "@/lib/prisma";
import * as cardService from "@/services/card.service";
import * as columnService from "@/services/column.service";
import * as commentService from "@/services/comment.service";
import { AppError } from "@/utils/errors";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolMessage {
  role: "tool";
  tool_call_id: string;
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
      // Sabit surum yerine "latest" takma adi: gemini-1.5/2.0/2.5 gibi
      // eski surumler yeni anahtarlara kapatiliyor (404 ya da kota 0).
      model: process.env.AI_MODEL || "gemini-flash-latest",
    };
  }

  return {
    provider: "openai",
    baseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
    apiKey,
    model: process.env.AI_MODEL || "gpt-4o-mini",
  };
}

// ─── Tool Definitions ───────────────────────────────────────────────

const TOOLS: {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}[] = [
  {
    type: "function",
    function: {
      name: "create_card",
      description: "Bir kolona yeni bir kart oluşturur. columnId zorunludur.",
      parameters: {
        type: "object",
        properties: {
          columnId: { type: "string", description: "Kolon ID'si" },
          title: { type: "string", description: "Kart başlığı" },
          description: { type: "string", description: "Kart açıklaması (opsiyonel)" },
          priority: {
            type: "string",
            enum: ["LOW", "MEDIUM", "HIGH", "URGENT"],
            description: "Öncelik (opsiyonel, varsayılan: MEDIUM)",
          },
          assigneeIds: {
            type: "array",
            items: { type: "string" },
            description: "Atanacak kullanıcı ID'leri (opsiyonel)",
          },
          dueDate: {
            type: "string",
            description: "Bitiş tarihi ISO format (opsiyonel)",
          },
        },
        required: ["columnId", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_card",
      description: "Bir kartı günceller. Sadece gönderilen alanlar değişir.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Kart ID'si" },
          title: { type: "string", description: "Yeni başlık" },
          description: { type: "string", description: "Yeni açıklama" },
          priority: {
            type: "string",
            enum: ["LOW", "MEDIUM", "HIGH", "URGENT"],
            description: "Öncelik",
          },
          dueDate: { type: "string", description: "Bitiş tarihi ISO format" },
        },
        required: ["cardId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_card",
      description: "Bir kartı siler.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Silinecek kart ID'si" },
        },
        required: ["cardId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_card",
      description: "Bir kartı başka bir kolona taşır.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Taşınacak kart ID'si" },
          targetColumnId: { type: "string", description: "Hedef kolon ID'si" },
        },
        required: ["cardId", "targetColumnId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assign_users",
      description: "Bir karta kullanıcı ataması yapar.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Kart ID'si" },
          assigneeIds: {
            type: "array",
            items: { type: "string" },
            description: "Atanacak kullanıcı ID'lerinin listesi (mevcut atamaları TAMAMEN değiştirir)",
          },
        },
        required: ["cardId", "assigneeIds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_comment",
      description: "Bir karta yorum ekler.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Kart ID'si" },
          text: { type: "string", description: "Yorum metni" },
        },
        required: ["cardId", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_columns",
      description: "Projedeki tüm kolonları ve kartları listeler. projectId otomatiktir, parametre verme.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

// ─── Tool Executor ──────────────────────────────────────────────────

async function executeTool(
  toolCall: ToolCall,
  userId: string,
  projectId: string,
): Promise<string> {
  const { name, arguments: argsRaw } = toolCall.function;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsRaw || "{}");
  } catch {
    return `❌ Geçersiz argüman formatı: ${argsRaw}`;
  }

  return executeToolByName(name, args, userId, projectId);
}

// Asil calistirma mantigi. Hem OpenAI (tool_calls) hem Gemini
// (functionCall) yolu buraya baglanir.
//
// Yetki kontrolu bilerek burada YOK: kart olusturma ve gorev atamasi
// icin ADMIN sarti card.service icinde uygulaniyor. Boylece AI uzerinden
// gelen istek de arayuzdeki ile birebir ayni kurallara tabi olur.
async function executeToolByName(
  name: string,
  args: Record<string, unknown>,
  userId: string,
  projectId: string,
): Promise<string> {
  try {
    switch (name) {
      case "create_card": {
        const { columnId, title, description, priority, assigneeIds, dueDate } = args as any;
        const card = await cardService.createCard(
          columnId,
          { title, description, priority, assigneeIds, dueDate },
          userId,
        );
        return `✅ Kart oluşturuldu: "${card.title}" (ID: ${card.id})`;
      }

      case "update_card": {
        const { cardId, title, description, priority, dueDate } = args as any;
        const card = await cardService.updateCard(
          cardId,
          { title, description, priority, dueDate },
          userId,
        );
        return `✅ Kart güncellendi: "${card.title}"`;
      }

      case "delete_card": {
        const { cardId } = args as any;
        await cardService.deleteCard(cardId, userId);
        return `✅ Kart silindi (ID: ${cardId})`;
      }

      case "move_card": {
        const { cardId, targetColumnId } = args as any;
        const card = await cardService.updateCard(
          cardId,
          { columnId: targetColumnId },
          userId,
        );
        return `✅ Kart taşındı: "${card.title}" → ${targetColumnId}`;
      }

      case "assign_users": {
        const { cardId, assigneeIds } = args as any;
        const card = await cardService.updateCard(
          cardId,
          { assigneeIds },
          userId,
        );
        const names = card.assignees
          .map((a: any) => a.user?.name || a.user?.id)
          .join(", ");
        return `✅ Kullanıcılar atandı: ${names}`;
      }

      case "add_comment": {
        const { cardId, text } = args as any;
        const comment = await commentService.createComment(
          cardId,
          { text },
          userId,
        );
        return `✅ Yorum eklendi (ID: ${comment.id})`;
      }

      case "list_columns": {
        const columns = await columnService.getColumns(projectId, userId);
        if (columns.length === 0) return "Bu projede henüz kolon yok.";

        const lines = columns.map(
          (c) =>
            `• "${c.name}" (${c._count?.cards ?? 0} kart) [ID: ${c.id}]`,
        );
        return `📋 Proje kolonları:\n${lines.join("\n")}`;
      }

      default:
        return `❌ Bilinmeyen araç: ${name}`;
    }
  } catch (error: any) {
    const message = error?.message || "Bilinmeyen hata";
    console.error(`[AI Tool] ${name} hatası:`, message);
    return `❌ İşlem başarısız: ${message}`;
  }
}

// ─── DSML Parser for DeepSeek Models ────────────────────────────────

function parseDSML(content: string): ToolCall[] | undefined {
  if (!content.includes("<｜｜DSML｜｜invoke")) {
    return undefined;
  }

  const toolCalls: ToolCall[] = [];
  
  // Extract all invoke blocks: <｜｜DSML｜｜invoke name="NAME">PARAMS</｜｜DSML｜｜invoke>
  const invokeRegex = /<｜｜DSML｜｜invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
  let invokeMatch;
  let index = 0;

  while ((invokeMatch = invokeRegex.exec(content)) !== null) {
    const functionName = invokeMatch[1];
    const paramsBlock = invokeMatch[2];
    
    // Extract all parameters: <｜｜DSML｜｜parameter name="NAME"[^>]*>VALUE</｜｜DSML｜｜parameter>
    const paramRegex = /<｜｜DSML｜｜parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
    let paramMatch;
    const args: Record<string, any> = {};

    while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
      const paramName = paramMatch[1];
      const paramValue = paramMatch[2].trim();
      
      let parsedValue: any = paramValue;
      if (
        (paramValue.startsWith("[") && paramValue.endsWith("]")) ||
        (paramValue.startsWith("{") && paramValue.endsWith("}")) ||
        paramValue === "true" ||
        paramValue === "false" ||
        (!isNaN(Number(paramValue)) && paramValue !== "")
      ) {
        try {
          parsedValue = JSON.parse(paramValue);
        } catch {
          // Keep as string if JSON parsing fails
        }
      }
      args[paramName] = parsedValue;
    }

    toolCalls.push({
      id: `dsml_call_${Date.now()}_${index++}`,
      type: "function",
      function: {
        name: functionName,
        arguments: JSON.stringify(args),
      },
    });
  }

  return toolCalls.length > 0 ? toolCalls : undefined;
}

// ─── API Call ───────────────────────────────────────────────────────

async function callOpenAI(
  provider: AIProvider,
  messages: (ChatMessage | ToolMessage)[],
  tools?: typeof TOOLS,
  signal?: AbortSignal,
): Promise<{ content: string; tool_calls?: ToolCall[] }> {
  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    max_tokens: 2048,
    temperature: 0.7,
  };

  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[AI] OpenAI API hatası:", response.status, errorBody);
    if (response.status === 401)
      return { content: "⚠️ API anahtarı geçersiz. Lütfen yöneticinizle iletişime geçin." };
    if (response.status === 429)
      return { content: "⚠️ Çok fazla istek gönderildi. Lütfen biraz bekleyip tekrar deneyin." };
    return { content: `⚠️ AI servisi şu anda kullanılamıyor. (Hata: ${response.status})` };
  }

  let raw = await response.text();
  raw = raw.replace(/\n?data:\s*\[DONE\]\s*$/i, "").trim();

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("[AI] JSON parse hatası, raw:", raw.slice(0, 500));
    return { content: "⚠️ AI servisinden geçersiz yanıt alındı." };
  }

  const choices = (data as any).choices;
  const msg = choices?.[0]?.message;
  if (!msg) return { content: "⚠️ AI asistanı boş cevap döndü." };

  // Reasoning modellerde (UwU) content boş olur, reasoning_content'te yanıt vardır
  // Tool çağrısı varsa reasoning_content'i atla (düşünme metnidir)
  // Tool çağrısı yoksa reasoning_content asıl yanıttır
  let toolCalls = msg.tool_calls;
  let content = msg.content || (toolCalls ? "" : (msg.reasoning_content || ""));

  // Check if content contains DSML tool calls (DeepSeek native format)
  if (content && content.includes("<｜｜DSML｜｜invoke")) {
    const dsmlCalls = parseDSML(content);
    if (dsmlCalls && dsmlCalls.length > 0) {
      toolCalls = toolCalls ? [...toolCalls, ...dsmlCalls] : dsmlCalls;
      content = content
        .replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/g, "")
        .replace(/<｜｜DSML｜｜invoke[\s\S]*?<\/｜｜DSML｜｜invoke>/g, "")
        .trim();
    }
  }

  return { content, tool_calls: toolCalls };
}

// ─── Gemini (function calling ile) ─────────────────────────────────

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

// OpenAI tool tanimlarini Gemini'nin functionDeclarations formatina cevirir.
// Parametre semasi ikisinde de JSON Schema oldugu icin oldugu gibi gecirilir.
function toGeminiFunctionDeclarations() {
  return [
    {
      functionDeclarations: TOOLS.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    },
  ];
}

function toGeminiContents(messages: (ChatMessage | ToolMessage)[]): {
  contents: GeminiContent[];
  systemInstruction: string;
} {
  const contents: GeminiContent[] = [];
  let systemInstruction = "";

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction += (systemInstruction ? "\n" : "") + (msg.content || "");
      continue;
    }
    if (msg.role === "tool") continue; // Gemini akisinda tool sonuclari ayrica eklenir

    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content || "" }],
    });
  }

  return { contents, systemInstruction };
}

async function callGeminiRaw(
  provider: AIProvider,
  contents: GeminiContent[],
  systemInstruction: string,
  withTools: boolean,
  signal?: AbortSignal,
): Promise<{ parts: GeminiPart[]; error?: string }> {
  const body: Record<string, unknown> = { contents };
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] };
  }
  if (withTools) {
    body.tools = toGeminiFunctionDeclarations();
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
    if (response.status === 400) return { parts: [], error: "⚠️ İstek formatı geçersiz." };
    if (response.status === 403)
      return { parts: [], error: "⚠️ API anahtarı geçersiz veya yetkisiz." };
    if (response.status === 404)
      return {
        parts: [],
        error: `⚠️ "${provider.model}" modeli bu API anahtarıyla kullanılamıyor. .env içindeki AI_MODEL değerini "gemini-flash-latest" yapın.`,
      };
    if (response.status === 429) {
      // limit: 0 → o modelde hic ucretsiz kota yok (surum kapatilmis olabilir);
      // diger 429'lar gercek hiz siniri, beklemek yeterli.
      const noQuota = errorBody.includes("limit: 0");
      return {
        parts: [],
        error: noQuota
          ? `⚠️ Bu API anahtarının "${provider.model}" modelinde kotası yok. .env içinde AI_MODEL="gemini-flash-latest" deneyin veya faturalandırmayı açın.`
          : "⚠️ İstek sınırına takıldınız. Lütfen birkaç saniye sonra tekrar deneyin.",
      };
    }
    return {
      parts: [],
      error: `⚠️ AI servisi şu anda kullanılamıyor. (Hata: ${response.status})`,
    };
  }

  const data = await response.json();
  const parts: GeminiPart[] = data.candidates?.[0]?.content?.parts ?? [];
  return { parts };
}

// Gemini ile cok turlu tool dongusu: model fonksiyon cagirir, sonucu
// functionResponse olarak geri veririz, model son cevabini uretir.
async function runGeminiWithTools(
  provider: AIProvider,
  messages: (ChatMessage | ToolMessage)[],
  userId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<string> {
  const { contents, systemInstruction } = toGeminiContents(messages);

  const MAX_ROUNDS = 4;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { parts, error } = await callGeminiRaw(
      provider,
      contents,
      systemInstruction,
      true,
      signal,
    );
    if (error) return error;

    const functionCalls = parts.filter(
      (p): p is { functionCall: { name: string; args?: Record<string, unknown> } } =>
        "functionCall" in p,
    );

    if (functionCalls.length === 0) {
      const text = parts
        .filter((p): p is { text: string } => "text" in p)
        .map((p) => p.text)
        .join("")
        .trim();
      return text || "⚠️ AI asistanı boş cevap döndü.";
    }

    // Modelin fonksiyon cagrilarini gecmise ekle
    contents.push({ role: "model", parts });

    const responseParts: GeminiPart[] = [];
    for (const { functionCall } of functionCalls) {
      const result = await executeToolByName(
        functionCall.name,
        functionCall.args ?? {},
        userId,
        projectId,
      );
      responseParts.push({
        functionResponse: {
          name: functionCall.name,
          response: { result },
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return "⚠️ İşlem çok fazla adım sürdü, tamamlanamadı. Lütfen isteğinizi sadeleştirin.";
}

// ─── Public API ─────────────────────────────────────────────────────

function buildSystemPrompt(
  projectName: string,
  boardContext: string,
  userName: string,
  userRole: "ADMIN" | "MEMBER",
): string {
  const isAdmin = userRole === "ADMIN";

  // Yetkiler arayuzdekiyle birebir ayni. Sunucu tarafinda card.service
  // zaten zorluyor; burada modele de soyluyoruz ki bosuna deneyip
  // kullaniciya hata mesaji gostermek yerine durumu acikca anlatsin.
  const permissions = isAdmin
    ? `Bu kullanıcı bu organizasyonda ADMIN. Tüm işlemleri yapabilirsin:
- Kart oluşturma, düzenleme, silme, taşıma
- Görev atama (assign_users) ve atamayı değiştirme
- Yorum ekleme, kolonları listeleme`
    : `Bu kullanıcı bu organizasyonda ÜYE (MEMBER), admin DEĞİL. Yetkileri sınırlı:
- YAPABİLİR: kart düzenleme, kart taşıma, kart silme, yorum ekleme, kolonları listeleme
- YAPAMAZ: yeni kart oluşturma (create_card) ve görev atama (assign_users)

Üye senden kart oluşturmanı veya birine görev atamanı isterse, bu aracı ÇAĞIRMA.
Bunun yerine kibarca "görev atama ve kart oluşturma yalnızca adminlerde, organizasyon
adminine iletebilirsin" de. Yine de denersen sunucu isteği reddeder.`;

  return `Sen bir Trello benzeri bir proje yönetim uygulamasının AI asistanısın.

Şu an seninle konuşan kullanıcı: ${userName} (rol: ${userRole})

${permissions}

Görev atama kuralı: Kullanıcı "X görevini Ahmet'e ata" derse, aşağıdaki listeden
Ahmet'in kullanıcı ID'sini ve kartın ID'sini bulup assign_users aracını çağır.
Bir karta birden fazla kişi atanabilir; assigneeIds gönderdiğin liste kartın YENİ
atanan listesidir (mevcutlara eklemek istiyorsan eskileri de listeye koy).

NOT: Proje ID'si, kolon ID'leri ve kullanıcı ID'leri aşağıda listelenmiştir. Kullanıcıya ID sorma, doğrudan kullan.

GRAFİK OLUŞTURMA YETENEĞİ:
Kullanıcı senden proje istatistikleri, iş yoğunluğu, tamamlanan işler veya kartların dağılımı ile ilgili görsel bir grafik/graf çizmesini AÇIKÇA talep ettiğinde (örneğin "grafik göster", "grafik çiz", "yoğunluk grafiği ver" vb.), yanıtında aşağıdaki özel markdown kod bloğunu kullan.
Kullanıcı açıkça bir grafik istemediyse (örneğin sadece "projede ne durumdayız", "hangi kartlar var", "X kartını oluştur" vb. dediğinde) KESİNLİKLE chart kod bloğu OLUŞTURMA, yanıtını normal metin olarak ver.

\`\`\`chart
{
  "type": "bar" | "pie" | "line",
  "title": "Grafik Başlığı",
  "data": [
    { "label": "Grup/Kişi/Sütun Adı", "value": sayısal_değer }
  ]
}
\`\`\`
Örnek durumlar:
1. Yoğunluk (İş yükü) Grafiği: Her kullanıcıya atanmış kart sayıları.
2. Sütun Dağılımı Grafiği: Kolonlardaki kart sayıları (To Do, In Progress, Done vb.).
3. Öncelik Dağılımı Grafiği: Öncelik derecelerine göre kart sayıları (LOW, MEDIUM, HIGH, URGENT).
Bu formatı birebir koru, kod bloğunun dilini "chart" olarak belirt ve geçerli bir JSON objesi sağla. Yanıtında bu bloğun yanına açıklamalar ekleyebilirsin.

Mevcut proje: "${projectName}"

Proje panosundaki mevcut durum:
${boardContext}

Kullanıcılara kısa, net ve Türkçe cevap ver. İşlem başarılı olduğunda ne yaptığını özetle.`;
}

async function getBoardContext(projectId: string): Promise<string> {
  // Ic ice iliskiler tek SQL'de (join) ve uyeler paralel: onceden 7-8
  // ayri gidis-donus vardi, her AI mesajinda tekrar odeniyordu.
  const [project, members] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      relationLoadStrategy: "join",
      include: {
        columns: {
          orderBy: { position: "asc" },
          include: {
            cards: {
              include: {
                assignees: { include: { user: { select: { id: true, name: true } } } },
                labels: { include: { label: { select: { name: true, color: true } } } },
              },
            },
          },
        },
      },
    }),
    prisma.organizationMember.findMany({
      where: { organization: { projects: { some: { id: projectId } } } },
      relationLoadStrategy: "join",
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
  ]);

  if (!project) return "";

  const parts: string[] = [];

  // Proje bilgisi
  parts.push(`Proje ID: ${project.id}`);
  parts.push(`Proje adı: ${project.name}`);

  // Kullanıcılar
  parts.push(
    `Organizasyon üyeleri:\n${members
      .map((m) => `  - ${m.user.name} (ID: ${m.user.id}, email: ${m.user.email})`)
      .join("\n")}`
  );

  // Kolonlar ve kartlar
  for (const col of project.columns) {
    const cardCount = col.cards.length;
    const cardList = col.cards
      .slice(0, 30)
      .map((c) => {
        let info = `    - "${c.title}" (ID: ${c.id})`;
        if (c.dueDate) info += ` (bitiş: ${new Date(c.dueDate).toLocaleDateString("tr-TR")})`;
        if (c.assignees.length) info += ` [${c.assignees.map((a) => a.user.name).join(", ")}]`;
        if (c.labels.length) info += ` etiket: ${c.labels.map((l) => l.label.name).join(", ")}`;
        return info;
      })
      .join("\n");

    parts.push(`Sütun: "${col.name}" (ID: ${col.id}) — ${cardCount} kart${cardList ? `\n${cardList}` : ""}`);
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
    return "⚠️ AI asistanı yapılandırılmamış. Lütfen yöneticinizle iletişime geçin.\n\n(.env dosyasında AI_API_KEY ve AI_PROVIDER değişkenlerini ayarlayın.)";
  }

  // Uc hazirlik sorgusu da birbirinden bagimsiz; sirayla beklemek yerine
  // paralel calisiyorlar (uzak DB'de her gidis-donus ~140ms).
  // Uyelik projenin organizationId'sine bagli oldugu icin dogrudan proje
  // uzerinden filtreleniyor, boylece proje sorgusunu beklemesi gerekmiyor.
  const [project, membership, boardContext] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true, organizationId: true },
    }),
    prisma.organizationMember.findFirst({
      where: { userId, organization: { projects: { some: { id: projectId } } } },
      select: { role: true, user: { select: { name: true } } },
    }),
    getBoardContext(projectId),
  ]);

  if (!project) return "⚠️ Proje bulunamadı.";
  if (!membership) return "⚠️ Bu projeye erişim yetkiniz yok.";
  const systemPrompt = buildSystemPrompt(
    project.name,
    boardContext,
    membership.user.name,
    membership.role as "ADMIN" | "MEMBER",
  );

  const recentMessages = messages.slice(-20);
  const apiMessages = [
    { role: "system" as const, content: systemPrompt },
    ...recentMessages.filter((m) => m.role !== "system"),
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    if (provider.provider === "google-gemini") {
      // Gemini — functionDeclarations ile ayni araclari kullanir
      return await runGeminiWithTools(
        provider,
        apiMessages,
        userId,
        projectId,
        controller.signal,
      );
    }

    // OpenAI-compatible (UwU dahil) — function calling ile çalışır
    // İlk tur: AI'ya mesaj + tools gönder, tool_calls bekle
    const first = await callOpenAI(provider, apiMessages, TOOLS, controller.signal);

    // Tool çağrısı yoksa direkt cevabı döndür
    if (!first.tool_calls?.length) {
      return first.content || "⚠️ AI asistanı boş cevap döndü.";
    }

    // Tool çağrılarını çalıştır
    const toolResults: ToolMessage[] = [];
    for (const tc of first.tool_calls) {
      const result = await executeTool(tc, userId, projectId);
      toolResults.push({ role: "tool", tool_call_id: tc.id, content: result });
    }

    // İkinci tur: tool sonuçlarını AI'ya gönder, doğal dil cevabı al
    const secondMessages = [
      ...apiMessages,
      { role: "assistant" as const, content: first.content || null, tool_calls: first.tool_calls },
      ...toolResults,
    ];

    const second = await callOpenAI(provider, secondMessages, undefined, controller.signal);
    return second.content || "✅ İşlem tamamlandı.";

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
      // Icgoru uretiminde arac cagrisina gerek yok, duz metin yeterli
      const { contents, systemInstruction } = toGeminiContents(messages);
      const { parts, error } = await callGeminiRaw(
        provider,
        contents,
        systemInstruction,
        false,
        controller.signal,
      );
      if (error) return "";
      return parts
        .filter((p): p is { text: string } => "text" in p)
        .map((p) => p.text)
        .join("")
        .trim();
    }
    const result = await callOpenAI(provider, messages, undefined, controller.signal);
    return result.content;
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateCardDetails(
  projectId: string,
  userId: string,
  title: string,
): Promise<{ description: string; priority: string; dueDate?: string; suggestedAssigneeId?: string }> {
  const provider = getProvider();

  if (!provider.apiKey) {
    throw new AppError(400, "AI asistanı yapılandırılmamış.", "AI_UNCONFIGURED");
  }

  const boardContext = await getBoardContext(projectId);
  const today = new Date().toISOString().split('T')[0];

  const prompt = `Sana verilecek olan görev/todo başlığına göre, bu görev için detaylı, profesyonel bir açıklama (description) ve uygun bir öncelik (LOW, MEDIUM, HIGH, URGENT) önerisi üret.
GÖREV BAŞLIĞININ DİLİ HANGİ DİLDEYSE (Türkçe, İngilizce, Almanca vb.), üreteceğin açıklama (description) metni de KESİNLİKLE o dilde olmalıdır.

Ayrıca, sana aşağıda proje panosunun mevcut durumunu (üyeler, mevcut sütunlardaki görevler, teslim tarihleri ve kimin ne kadar iş yükü olduğu) iletiyorum:
---
${boardContext}
---
Bugünün tarihi: ${today}

Lütfen bu bilgilere dayanarak:
1. Diğer görevlerin teslim tarihlerini ve yoğunluğunu analiz ederek, bu yeni görev için gerçekçi ve uygun bir son teslim tarihi (dueDate) öner (YYYY-MM-DD formatında).
2. Üyelerin mevcut iş yüklerini (yani üzerlerindeki aktif kart sayılarını) ve rollerini analiz ederek, bu göreve en müsait olan veya en az iş yüküne sahip olan en uygun organizasyon üyesinin ID'sini (suggestedAssigneeId) öner.

Görev Başlığı: "${title}"

Yanıtı KESİNLİKLE sadece aşağıdaki JSON formatında ver, XML veya markdown açıklamaları ekleme. JSON dışında bir şey yazarsan sistem hata verecektir.

Format:
{
  "description": "Görev için detaylı, açıklayıcı metin...",
  "priority": "LOW" | "MEDIUM" | "HIGH" | "URGENT",
  "dueDate": "YYYY-MM-DD",
  "suggestedAssigneeId": "müsait_üye_user_id"
}`;

  const messages = [
    { role: "system" as const, content: "Sen sadece JSON döndüren bir yardımcı asistansın." },
    { role: "user" as const, content: prompt }
  ];

  let rawReply = "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  try {
    if (provider.provider === "google-gemini") {
      const { contents, systemInstruction } = toGeminiContents(messages);
      const { parts, error } = await callGeminiRaw(
        provider,
        contents,
        systemInstruction,
        false,
        controller.signal,
      );
      if (error) throw new Error(error);
      rawReply = parts
        .filter((p): p is { text: string } => "text" in p)
        .map((p) => p.text)
        .join("")
        .trim();
    } else {
      const reply = await callOpenAI(provider, messages, undefined, controller.signal);
      rawReply = reply.content.trim();
    }
  } catch (err: any) {
    console.error("[AI FILL] Request error:", err);
    throw new AppError(500, "AI servisine bağlanırken bir hata oluştu.", "AI_REQUEST_FAILED");
  } finally {
    clearTimeout(timeout);
  }

  const cleaned = rawReply.replace(/```json\s*|```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      description: parsed.description || "",
      priority: parsed.priority || "MEDIUM",
      dueDate: parsed.dueDate || undefined,
      suggestedAssigneeId: parsed.suggestedAssigneeId || undefined,
    };
  } catch (err) {
    console.error("[AI FILL] JSON parse error. Raw reply was:", rawReply);
    return {
      description: `Bu görev başlığı için otomatik açıklama: ${title}`,
      priority: "MEDIUM",
    };
  }
}

