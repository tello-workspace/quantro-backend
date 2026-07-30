import { prisma } from "@/lib/prisma";
import * as cardService from "@/services/card.service";
import * as columnService from "@/services/column.service";
import * as commentService from "@/services/comment.service";
import { AppError } from "@/utils/errors";
import { decryptSecret } from "@/utils/crypto";

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

async function getProvider(userId?: string): Promise<AIProvider> {
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        aiProvider: true,
        aiApiKey: true,
        aiBaseUrl: true,
        aiModel: true,
      },
    });

    if (user && user.aiProvider && user.aiApiKey) {
      // aiApiKey DB'de sifreli tutulur (bkz. utils/crypto.ts). Cozulemezse
      // (AI_KEY_SECRET degismis, bozuk veri) global saglayiciya dusulur -
      // kullanicinin AI ozelligi tamamen kirilmasin diye.
      const decryptedKey = decryptSecret(user.aiApiKey);
      if (decryptedKey) {
        return {
          provider: user.aiProvider as AIProvider["provider"],
          baseUrl: user.aiBaseUrl || (user.aiProvider === "google-gemini" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.openai.com/v1"),
          apiKey: decryptedKey,
          model: user.aiModel || (user.aiProvider === "google-gemini" ? "gemini-flash-latest" : "gpt-4o-mini"),
        };
      }
    }
  }

  const provider = (process.env.AI_PROVIDER || "openai") as AIProvider["provider"];
  const apiKey = process.env.AI_API_KEY || "";

  if (provider === "google-gemini") {
    return {
      provider: "google-gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey,
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
        const columns = await prisma.column.findMany({
          where: { projectId },
          orderBy: { position: "asc" },
          include: {
            cards: {
              include: {
                assignees: { include: { user: { select: { id: true, name: true } } } },
              }
            }
          }
        });
        if (columns.length === 0) return "Bu projede henüz kolon yok.";

        const lines = columns.map((c) => {
          let cardDetails = "";
          if (c.cards.length > 0) {
            cardDetails = "\n" + c.cards.map(card => {
              const assigneesStr = card.assignees.map(a => a.user.name).join(", ");
              return `    - "${card.title}" (ID: ${card.id})${assigneesStr ? ` [Atanan: ${assigneesStr}]` : ""}`;
            }).join("\n");
          }
          return `• "${c.name}" (ID: ${c.id}) — ${c.cards.length} kart${cardDetails}`;
        });
        return `📋 Proje kolonları ve kart detayları:\n${lines.join("\n\n")}`;
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

interface OpenAICallResult {
  content: string;
  tool_calls?: ToolCall[];
  // 429 oldugu ve Groq/OpenAI "retry-after" header'i verdigi durumda true olur -
  // cagiran taraf bir kez yeniden dener. Gemini tarafindaki ayni desenin esi.
  retryable?: boolean;
  retryDelayMs?: number;
}

async function callOpenAIOnce(
  provider: AIProvider,
  messages: (ChatMessage | ToolMessage)[],
  tools?: typeof TOOLS,
  signal?: AbortSignal,
  responseFormat?: { type: "json_object" },
): Promise<OpenAICallResult> {
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

  if (responseFormat) {
    body.response_format = responseFormat;
  }

  const isOpenRouter = provider.baseUrl.includes("openrouter.ai");

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
      ...(isOpenRouter ? {
        "HTTP-Referer": process.env.FRONTEND_URL?.split(",")[0]?.trim() || "https://tello-frontend.onrender.com",
        "X-Title": "Tello",
      } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[AI] OpenAI API hatası:", response.status, errorBody);
    if (response.status === 401)
      return { content: "⚠️ API anahtarı geçersiz. Lütfen yöneticinizle iletişime geçin." };
    if (response.status === 429) {
      // Groq/OpenAI "retry-after" header'i saniye cinsinden gelir (bkz.
      // console.groq.com/docs/rate-limits). Bu Tello'nun kendi limiti degil,
      // saglayicinin (Groq/OpenAI) dakikalik token/istek kotasi - checkAiRateLimit
      // ile karistirilmasin.
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSec = retryAfterHeader ? parseFloat(retryAfterHeader) : NaN;
      return {
        content: "⚠️ AI sağlayıcısı hız sınırına takıldı. Otomatik olarak tekrar deneniyor...",
        retryable: true,
        retryDelayMs: !isNaN(retryAfterSec) ? Math.min(Math.ceil(retryAfterSec * 1000), 10_000) : undefined,
      };
    }
    // Detayli hatayi goster (OpenRouter vb. ozel mesajlar icin)
    let detail = "";
    try { const j = JSON.parse(errorBody); detail = j.error?.message || j.error?.code || ""; } catch {}
    const extra = detail ? ` — ${detail}` : "";
    return { content: `⚠️ AI servisi şu anda kullanılamıyor. (Hata: ${response.status})${extra}` };
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
  if (!msg) {
    const reason = choices?.[0]?.finish_reason || "bilinmiyor";
    return { content: `⚠️ AI asistanı boş cevap döndü. (Sebep: ${reason}) — API anahtarının geçerli olduğundan ve model adının doğru yazıldığından emin olun.` };
  }

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

async function callOpenAI(
  provider: AIProvider,
  messages: (ChatMessage | ToolMessage)[],
  tools?: typeof TOOLS,
  signal?: AbortSignal,
  responseFormat?: { type: "json_object" },
): Promise<{ content: string; tool_calls?: ToolCall[]; rateLimited?: boolean }> {
  const MAX_RETRIES = 3;
  const DELAYS = [3000, 5000, 8000]; // her denemede artan bekleme

  let lastResult: OpenAICallResult | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await callOpenAIOnce(provider, messages, tools, signal, responseFormat);
    lastResult = result;

    if (!result.retryable) return result;

    // Hala 429 - bir sonraki denemeyi dene
    const delay = result.retryDelayMs ?? DELAYS[attempt - 1] ?? 5000;
    console.warn(`[AI] Groq/OpenAI 429 (gecici hiz siniri) - ${delay}ms sonra tekrar deneniyor... (Deneme ${attempt}/${MAX_RETRIES})`);
    await sleep(delay);
  }

  // Tum denemeler 429 dondu - kullaniciya net mesaj
  return {
    content: "⚠️ AI sağlayıcısının hız sınırına takıldık. 3 kez tekrar denendi ancak sunucu hala müsait değil. Lütfen birkaç dakika sonra tekrar deneyin.",
    rateLimited: true,
  };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini'nin 429 govdesindeki RetryInfo.retryDelay ("20s" gibi) alanini
// okur. Bulunamaz/parse edilemezse null doner, cagiran taraf varsayilan
// bir sure kullanir. 10sn ile sinirlanir - kendi istek zaman asimlarimizi
// (15-35sn) anlamsizca doldurmasin.
function parseRetryDelayMs(errorBody: string): number | null {
  try {
    const parsed = JSON.parse(errorBody);
    const details = parsed?.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        const match = /^(\d+(?:\.\d+)?)s$/.exec(detail?.retryDelay ?? "");
        if (match) return Math.min(Math.ceil(parseFloat(match[1]) * 1000), 10_000);
      }
    }
  } catch {
    // JSON degilse veya beklenen sekilde degilse yoksay
  }
  return null;
}

interface GeminiCallResult {
  parts: GeminiPart[];
  error?: string;
  // 429 oldugu ve gercek kota tukenmesi (limit: 0) DEGIL, gecici bir hiz
  // siniri oldugu durumda true olur - cagiran taraf bir kez yeniden dener.
  retryable?: boolean;
  retryDelayMs?: number;
}

async function callGeminiOnce(
  provider: AIProvider,
  contents: GeminiContent[],
  systemInstruction: string,
  withTools: boolean,
  signal?: AbortSignal,
): Promise<GeminiCallResult> {
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
      // diger 429'lar Google'in dakikalik/gunluk hiz siniri - gecici, retry ile atlatilabilir.
      const noQuota = errorBody.includes("limit: 0");
      if (noQuota) {
        return {
          parts: [],
          error: `⚠️ Bu API anahtarının "${provider.model}" modelinde kotası yok. .env içinde AI_MODEL="gemini-flash-latest" deneyin veya faturalandırmayı açın.`,
        };
      }
      return {
        parts: [],
        // NOT: Bu Quantro'nun kendi kullanim limiti DEGIL, Google Gemini'nin
        // ucretsiz katman hiz siniri - checkAiRateLimit ile karistirilmasin.
        error: "⚠️ Google Gemini hız sınırına takıldı. Otomatik olarak tekrar deneniyor...",
        retryable: true,
        retryDelayMs: parseRetryDelayMs(errorBody) ?? undefined,
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

async function callGeminiRaw(
  provider: AIProvider,
  contents: GeminiContent[],
  systemInstruction: string,
  withTools: boolean,
  signal?: AbortSignal,
): Promise<{ parts: GeminiPart[]; error?: string }> {
  const MAX_RETRIES = 3;
  const DELAYS = [3000, 5000, 8000];

  let lastResult: GeminiCallResult | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await callGeminiOnce(provider, contents, systemInstruction, withTools, signal);
    lastResult = result;

    if (!result.retryable) return result;

    const delay = result.retryDelayMs ?? DELAYS[attempt - 1] ?? 5000;
    console.warn(`[AI] Gemini 429 (gecici hiz siniri) - ${delay}ms sonra tekrar deneniyor... (Deneme ${attempt}/${MAX_RETRIES})`);
    await sleep(delay);
  }

  return {
    parts: [],
    error: "⚠️ Google Gemini'nin hız sınırına takıldık. 3 kez tekrar denendi ancak sunucu hala müsait değil. Lütfen birkaç dakika sonra tekrar deneyin.",
  };
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
      if (!text) {
        // Gemini'den hiç text gelmemesi: model bulunamadı, içerik engellendi
        const blockReason = (parts.length > 0 ? "content_filter" : "model_not_found");
        return `⚠️ AI asistanı boş cevap döndü. (Sebep: ${blockReason}) — Model adını ve API anahtarını kontrol edin.`;
      }
      return text;
    }

    // Modelin fonksiyon cagrilarini gecmise ekle
    contents.push({ role: "model", parts });

    const responseParts: GeminiPart[] = [];
    const batchSize = 5;
    for (let i = 0; i < functionCalls.length; i += batchSize) {
      const batch = functionCalls.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async ({ functionCall }) => {
          const result = await executeToolByName(
            functionCall.name,
            functionCall.args ?? {},
            userId,
            projectId,
          );
          return {
            functionResponse: {
              name: functionCall.name,
              response: { result },
            },
          };
        })
      );
      responseParts.push(...batchResults);
    }
    contents.push({ role: "user", parts: responseParts });

    if (functionCalls.length > 5) {
      const successCount = responseParts.filter(
        (p): p is { functionResponse: { name: string; response: { result: string } } } =>
          "functionResponse" in p && typeof p.functionResponse.response.result === "string" && p.functionResponse.response.result.includes("✅")
      ).length;
      
      const failCount = responseParts.filter(
        (p): p is { functionResponse: { name: string; response: { result: string } } } =>
          "functionResponse" in p && typeof p.functionResponse.response.result === "string" && p.functionResponse.response.result.includes("❌")
      ).length;

      const summaries = responseParts
        .map((p) => ("functionResponse" in p ? (p.functionResponse.response.result as string) : ""))
        .filter(Boolean)
        .join("\n");

      return `🤖 **Toplu İşlem Özeti:**\n\nBaşarıyla tamamlanan: ${successCount}\nHatalı/Başarısız: ${failCount}\n\n**Detaylar:**\n${summaries}`;
    }
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

YETKİNLİK BAZLI OTOMATİK ATAMA (SADECE ADMIN İÇİN):
Kullanıcı açıkça birini belirtmeden "bir backend görevi oluştur", "bunu frontendciye ata" gibi
ifadeler kullanırsa, aşağıdaki adımları uygula:

Adım 1 — Analiz: Görev açıklamasından hangi yetkinlik gerektiğini çıkar.
  - "Backend", "API", "veritabanı", "sunucu", "auth", "endpoint" → Backend
  - "Frontend", "ön yüz", "React", "UI", "arayüz", "tasarım" → Frontend
  - "DevOps", "dağıtım", "CI/CD", "docker", "sunucu yönetimi" → DevOps
  - "test", "kalite", "QA" → Test
  - "tasarım", "UI/UX", "kullanıcı deneyimi" → UI/UX

Adım 2 — Eşleştirme: Çıkardığın yetkinliğe sahip üyeleri organizasyon listesinden bul.
  Her üyenin yanında admin tarafından verilmiş "Yetkinlik (rozet): ..." ve kullanıcının
  kendi profilinde beyan ettiği "Uzmanlık alanları (profil): ..." / "Bildiği diller (profil): ..."
  bilgileri listelenmiştir. İkisini birlikte değerlendir: rozet ile profil bilgisi birbirini
  DOĞRULUYORSA (ikisi de aynı alanı işaret ediyorsa) o kişiyi güçlü aday say. Sadece rozeti
  veya sadece profil bilgisi olan biri de geçerli bir adaydır, ikisi de yoksa aday değildir.

Adım 3 — İş yükü optimizasyonu: Aynı yetkinlikte birden fazla kişi varsa, To Do ve
  In Progress sütunlarında daha az kartı olanı seç (kart listesinden kendin hesapla).

Adım 4 — 🟡 Fallback (eşleşme yoksa):
  Eğer gerekli yetkinliğe (ne rozet ne profil) sahip hiçbir üye bulamazsan, KESİNLİKLE
  assign_users ÇAĞIRMA. Görevi oluştur (create_card) ama kimseye atama. Kartın açıklamasına
  veya yanıtında "Bu görev için uygun yetkinlik/uzmanlığa sahip bir üye bulunamadı" yaz.

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
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    }),
  ]);

  if (!project) return "";

  const parts: string[] = [];

  // Proje bilgisi
  parts.push(`Proje ID: ${project.id}`);
  parts.push(`Proje adı: ${project.name}`);

  // Kullanıcılar (rozet + kendi profillerinde beyan ettikleri uzmanlık/dil bilgisiyle)
  parts.push(
    `Organizasyon üyeleri:\n${members
      .map((m: any) => {
        const badges = m.user.badges?.map((ub: any) => ub.badge.name).join(", ");
        const extras: string[] = [];
        if (m.user.title) extras.push(`Unvan: ${m.user.title}`);
        if (badges) extras.push(`Yetkinlik (rozet): ${badges}`);
        if (m.user.expertiseAreas?.length) extras.push(`Uzmanlık alanları (profil): ${m.user.expertiseAreas.join(", ")}`);
        if (m.user.languages?.length) extras.push(`Bildiği diller (profil): ${m.user.languages.join(", ")}`);
        return `  - ${m.user.name} (ID: ${m.user.id}, email: ${m.user.email})${extras.length ? ` — ${extras.join(" | ")}` : ""}`;
      })
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
  const provider = await getProvider(userId);

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
  const timeout = setTimeout(() => controller.abort(), 60000);

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
    // Çok turlu tool döngüsü (Gemini ile paralel mantıkta)
    const chatMessages: (ChatMessage | ToolMessage)[] = [...apiMessages];
    const MAX_ROUNDS = 4;

    // Boş/geçersiz cevap durumunda bir kez tekrar dene (OpenRouter transient hata).
    // rateLimited=true ise callOpenAI zaten 3 kez backoff'lu denedi ve hala
    // 429 aldi - burada tekrar denemek Groq'un dakikalik
    // kotasini daha da zorlar, sadece gerçek parse/bos-cevap
    // hatalarinda tekrar deniyoruz.
    let retried = false;
    const callWithRetry = async (msgs: typeof chatMessages, tools?: typeof TOOLS) => {
      const reply = await callOpenAI(provider, msgs, tools, controller.signal);
      if (reply.content?.startsWith("⚠️") && !reply.rateLimited && !retried) {
        retried = true;
        console.warn("[AI] Ilk denemede hata, bir kez yeniden deneniyor...");
        return callOpenAI(provider, [...apiMessages], tools, controller.signal);
      }
      return reply;
    };

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Son turda tool göndermeyerek modeli düz metin cevap vermeye zorluyoruz
      const activeTools = round < MAX_ROUNDS - 1 ? TOOLS : undefined;
      const reply = await callWithRetry(chatMessages, activeTools);

      if (!reply.tool_calls?.length) {
        return reply.content || "✅ İşlem tamamlandı.";
      }

      // Modelin tool çağrısını geçmişe ekle
      chatMessages.push({
        role: "assistant" as const,
        content: reply.content || null,
        tool_calls: reply.tool_calls,
      });

      // Tool çağrılarını 5'erli gruplar halinde paralel çalıştırıp geçmişe ekle
      const batchSize = 5;
      const roundToolCalls = reply.tool_calls;
      const results: (ChatMessage | ToolMessage)[] = [];
      for (let i = 0; i < roundToolCalls.length; i += batchSize) {
        const batch = roundToolCalls.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(async (tc) => {
            const result = await executeTool(tc, userId, projectId);
            return {
              role: "tool" as const,
              tool_call_id: tc.id,
              content: result,
            };
          })
        );
        results.push(...batchResults);
      }
      chatMessages.push(...results);

      if (roundToolCalls.length > 5) {
        const successCount = results.filter(m => m.role === "tool" && m.content.includes("✅")).length;
        const failCount = results.filter(m => m.role === "tool" && m.content.includes("❌")).length;
        const summaries = results
          .filter(m => m.role === "tool")
          .map(m => m.content)
          .join("\n");
        return `🤖 **Toplu İşlem Özeti:**\n\nBaşarıyla tamamlanan: ${successCount}\nHatalı/Başarısız: ${failCount}\n\n**Detaylar:**\n${summaries}`;
      }
    }

    return "⚠️ İşlem çok fazla adım sürdü, tamamlanamadı. Lütfen isteğinizi sadeleştirin.";

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
  userId?: string,
): Promise<string> {
  const provider = await getProvider(userId);
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
  const provider = await getProvider(userId);

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
1. Diğer görevlerin teslim tarihlerini ve yoğunluğunu analiz ederek, bu yeni görev için gerçekçi ve uygun bir son teslim tarihi (dueDate) belirle (KESİNLİKLE YYYY-MM-DD formatında gerçek bir tarih olmalıdır. Eğer tarih belirlenemezse bugünden 3 gün sonrasını yaz).
2. En uygun atanacak kişiyi (suggestedAssigneeId) şu ÖNCELİK SIRASINA göre seç:
   a) ÖNCE İÇERİK EŞLEŞMESİ: Görev başlığından hangi yetkinliğin gerektiğini çıkar (örn. "API entegrasyonu" → Backend, "arayüz tasarımı" → Frontend/UI-UX, "dağıtım" → DevOps, "test" → Test/QA). Üyelerin yanında listelenen "Yetkinlik (rozet)", "Uzmanlık alanları (profil)" ve "Bildiği diller (profil)" bilgilerini bu gereksinimle karşılaştır ve en iyi eşleşen üye(leri) belirle.
   b) EŞİTLİK DURUMUNDA İŞ YÜKÜ: Birden fazla üye aynı derecede uygunsa, aralarından mevcut aktif kart sayısı (iş yükü) en az olanı seç.
   c) EŞLEŞME YOKSA: Hiçbir üyenin yetkinliği/uzmanlığı görevle örtüşmüyorsa, o zaman sadece iş yüküne bakarak en müsait üyeyi seç.
   Seçtiğin kişinin ID'sini (suggestedAssigneeId) yaz (KESİNLİKLE yukarıda listelenen üyelerden birinin ID'si olmalıdır. Organizasyonda hiç üye yoksa null yaz).

Görev Başlığı: "${title}"

Yanıtı KESİNLİKLE sadece aşağıdaki JSON formatında ver, XML veya markdown açıklamaları ekleme. JSON dışı hiçbir metin yazma. Tüm alanlar KESİNLİKLE doldurulmalıdır.

Format:
{
  "description": "Görev açıklaması buraya yazılacak",
  "priority": "MEDIUM",
  "dueDate": "${today}",
  "suggestedAssigneeId": "cms2w9f130001jfzcaxxic03q"
}`;

  const messages = [
    { role: "system" as const, content: "Sen bir JSON API servisisin. Yanıtında KESİNLİKLE açıklama, konuşma, markdown veya backtick kullanma. Sadece geçerli bir JSON objesi döndür." },
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
      let reply;
      try {
        reply = await callOpenAI(
          provider,
          messages,
          undefined,
          controller.signal,
          { type: "json_object" }
        );
      } catch (err) {
        console.warn("[AI FILL] response_format failed, falling back without it:", err);
        reply = await callOpenAI(provider, messages, undefined, controller.signal);
      }
      rawReply = reply.content.trim();
    }
  } catch (err: any) {
    console.error("[AI FILL] Request error:", err);
    throw new AppError(500, "AI servisine bağlanırken bir hata oluştu.", "AI_REQUEST_FAILED");
  } finally {
    clearTimeout(timeout);
  }

  let parsed: any = null;
  const trimmedReply = rawReply.trim();
  
  // Try extracting the JSON block between first '{' and last '}'
  const firstBrace = trimmedReply.indexOf('{');
  const lastBrace = trimmedReply.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const jsonCandidate = trimmedReply.substring(firstBrace, lastBrace + 1);
    try {
      parsed = JSON.parse(jsonCandidate);
    } catch (err) {
      console.error("[AI FILL] JSON parse of extracted block failed:", err);
    }
  }

  // Fallback to cleaning backticks if extraction failed
  if (!parsed) {
    try {
      const cleaned = trimmedReply.replace(/```json\s*|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error("[AI FILL] JSON parse error. Raw reply was:", rawReply);
    }
  }

  if (parsed) {
    let priorityVal = "MEDIUM";
    if (parsed.priority) {
      const p = parsed.priority.toString().toUpperCase().trim();
      if (["LOW", "MEDIUM", "HIGH", "URGENT"].includes(p)) {
        priorityVal = p;
      }
    }

    let dueDateVal = parsed.dueDate;
    if (dueDateVal === "YYYY-MM-DD" || dueDateVal === "null" || dueDateVal === "undefined" || !dueDateVal) {
      const d = new Date();
      d.setDate(d.getDate() + 3);
      dueDateVal = d.toISOString().split('T')[0];
    } else {
      dueDateVal = dueDateVal.toString().trim();
    }

    let suggestedAssigneeVal = parsed.suggestedAssigneeId;
    if (suggestedAssigneeVal === "null" || suggestedAssigneeVal === "undefined" || suggestedAssigneeVal === "müsait_üye_user_id") {
      suggestedAssigneeVal = undefined;
    } else if (suggestedAssigneeVal) {
      suggestedAssigneeVal = suggestedAssigneeVal.toString().trim();
    }

    return {
      description: parsed.description || `Bu görev başlığı için otomatik açıklama: ${title}`,
      priority: priorityVal,
      dueDate: dueDateVal,
      suggestedAssigneeId: suggestedAssigneeVal,
    };
  }

  // Final fallback if JSON parsing fails completely
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return {
    description: `Bu görev başlığı için otomatik açıklama: ${title}`,
    priority: "MEDIUM",
    dueDate: d.toISOString().split('T')[0],
  };
}


export async function analyzePushAndMoveCards(userId: string, commitMessage: string, diff: string) {
  console.log(`[AI PUSH ANALYZER] Analiz başladı. User ID: ${userId}`);
  console.log(`[AI PUSH ANALYZER] Commit Mesajı: "${commitMessage}"`);
  console.log(`[AI PUSH ANALYZER] Git Diff Uzunluğu: ${diff ? diff.length : 0} karakter`);

  // 1. Fetch user's cards (bitmis/isDone sutunlardaki kartlar aday disi
  // birakiliyor: zaten kapanmis bir isi push analizine gore yeniden
  // acmaya/tasimaya gerek yok)
  const userCards = await prisma.card.findMany({
    where: {
      assignees: {
        some: {
          userId: userId
        }
      },
      column: { isDone: false },
    },
    include: {
      column: {
        include: {
          project: {
            include: {
              columns: true
            }
          }
        }
      }
    }
  });

  console.log(`[AI PUSH ANALYZER] Kullanıcıya atanan kart sayısı: ${userCards.length}`);
  userCards.forEach(c => {
    console.log(`  -> Kart ID: ${c.id} | Başlık: "${c.title}" | Sütun: "${c.column.name}" | Proje: "${c.column.project.name}"`);
  });

  if (userCards.length === 0) {
    console.log(`[AI PUSH ANALYZER] Kullanıcının atalı olduğu aktif kart yok, çıkılıyor.`);
    return { movedCards: [] };
  }

  const cardsData = userCards.map(c => ({
    id: c.id,
    title: c.title,
    description: c.description || "",
    currentColumn: c.column.name,
    projectTitle: c.column.project.name,
    availableColumns: c.column.project.columns.map(col => ({
      id: col.id,
      name: col.name
    }))
  }));

  // Diff cok buyuk olabiliyor (bazi commit'ler yuzlerce satir degistiriyor);
  // AI'a gonderilecek token maliyetini ve isteginin boyutunu sinirlamak icin
  // kirpiliyor.
  const truncatedDiff = diff && diff.length > 4000 ? `${diff.slice(0, 4000)}\n... (diff kısaltıldı)` : diff;

  const prompt = `Sen bir yazılım proje yönetimi asistanısın. Bir geliştirici git push yaptı.
Commit mesajı:
${commitMessage}

Git diff:
${truncatedDiff}

Bu geliştiriciye atanan aktif kartlar şunlardır:
${JSON.stringify(cardsData, null, 2)}

Görevin:
1. Geliştiricinin yaptığı kod değişikliklerini (diff) ve commit mesajını analiz ederek, atanan kartlardan hangilerinin durumunun değişmesi gerektiğini tespit et.
2. Örneğin, commit mesajında "fix #12" diyorsa veya kodda o kartın başlığıyla/açıklamasıyla ilgili bir özellik/hata çözülmüşse veya test edilmişse, kartı en uygun sütuna ("Yapılıyor", "Test", "Done/Bitti", vb.) geçir. Eşleşme yoksa o kart için bir değişiklik önerme.
3. KESİNLİKLE hiçbir açıklama, analiz veya konuşma metni ekleme. SADECE aşağıdaki yapıda geçerli bir JSON objesi döndür.

Format:
{
  "decisions": [
    {
      "cardId": "kart_id_değeri",
      "targetColumnId": "hedef_kolon_id_değeri",
      "reason": "Kısa Türkçe gerekçe"
    }
  ]
}
`;

  const messages: ChatMessage[] = [
    { role: "system", content: "Sen bir JSON API asistanısın. Yanıtında KESİNLİKLE açıklama, analiz, markdown veya normal metin kullanamazsın. SADECE istenen şemada geçerli bir JSON objesi döndür." },
    { role: "user", content: prompt },
  ];

  const provider = await getProvider(userId);
  console.log(`[AI PUSH ANALYZER] Seçilen AI Sağlayıcı: ${provider.provider} | Model: ${provider.model}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  let responseText = "";
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
      if (!error) {
        responseText = parts
          .filter((p): p is { text: string } => "text" in p)
          .map((p) => p.text)
          .join("")
          .trim();
      } else {
        console.error(`[AI PUSH ANALYZER] Gemini raw hatası:`, error);
      }
    } else {
      let result;
      try {
        result = await callOpenAI(
          provider,
          messages,
          undefined,
          controller.signal,
          { type: "json_object" }
        );
      } catch (err) {
        console.warn("[AI PUSH ANALYZER] JSON mode failed, falling back without it:", err);
        result = await callOpenAI(provider, messages, undefined, controller.signal);
      }
      responseText = result.content || "";
    }
  } catch (err) {
    console.error("[AI PUSH ANALYZER] AI çağrısı sırasında hata:", err);
  } finally {
    clearTimeout(timeout);
  }

  console.log(`[AI PUSH ANALYZER] AI Ham Cevap: "${responseText}"`);

  if (!responseText) {
    console.log(`[AI PUSH ANALYZER] AI'dan yanıt gelmedi, çıkılıyor.`);
    return { movedCards: [] };
  }

  // Markdown code block'larını temizle (AI bazen ```json ... ``` ile dönebilir)
  const cleanText = responseText.replace(/```json/g, "").replace(/```/g, "").trim();

  // Konuşma/Düşünce metinleri arasından JSON objesini veya array'ini bulup çıkar
  let decisions: any[] = [];
  try {
    // Önce doğrudan parse etmeyi dene
    const parsed = JSON.parse(cleanText);
    decisions = Array.isArray(parsed) ? parsed : (parsed.decisions || []);
  } catch (err) {
    // Doğrudan parse başarısız olursa, parantez/küme parantezi bazlı ayıklamayı dene
    const firstBracket = cleanText.indexOf('[');
    const lastBracket = cleanText.lastIndexOf(']');
    const firstCurly = cleanText.indexOf('{');
    const lastCurly = cleanText.lastIndexOf('}');

    // Eğer array parantezleri varsa ve daha dıştaysa veya curly yoksa array dene
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket && (firstCurly === -1 || firstBracket < firstCurly)) {
      try {
        const sliced = cleanText.substring(firstBracket, lastBracket + 1);
        const parsed = JSON.parse(sliced);
        decisions = Array.isArray(parsed) ? parsed : (parsed.decisions || []);
      } catch (e2) {
        // Array denemesi başarısız, curly dene
        if (firstCurly !== -1 && lastCurly !== -1 && lastCurly > firstCurly) {
          try {
            const sliced = cleanText.substring(firstCurly, lastCurly + 1);
            const parsed = JSON.parse(sliced);
            decisions = Array.isArray(parsed) ? parsed : (parsed.decisions || []);
          } catch (e3) {
            console.error("[AI PUSH ANALYZER] Hem array hem obje ayıklama başarısız oldu:", e3);
          }
        }
      }
    } else if (firstCurly !== -1 && lastCurly !== -1 && lastCurly > firstCurly) {
      // Önce curly dene
      try {
        const sliced = cleanText.substring(firstCurly, lastCurly + 1);
        const parsed = JSON.parse(sliced);
        decisions = Array.isArray(parsed) ? parsed : (parsed.decisions || []);
      } catch (e2) {
        // Curly başarısız, bracket dene
        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
          try {
            const sliced = cleanText.substring(firstBracket, lastBracket + 1);
            const parsed = JSON.parse(sliced);
            decisions = Array.isArray(parsed) ? parsed : (parsed.decisions || []);
          } catch (e3) {
            console.error("[AI PUSH ANALYZER] Hem obje hem array ayıklama başarısız oldu:", e3);
          }
        }
      }
    }
  }

  console.log(`[AI PUSH ANALYZER] Ayrıştırılan Kararlar:`, decisions);

  if (!Array.isArray(decisions)) {
    console.log(`[AI PUSH ANALYZER] Kararlar bir array değil, çıkılıyor.`);
    return { movedCards: [] };
  }

  const movedCards: any[] = [];
  for (const decision of decisions) {
    const { cardId, targetColumnId, reason } = decision;
    if (!cardId || !targetColumnId) {
      console.log(`[AI PUSH ANALYZER] Geçersiz karar verisi:`, decision);
      continue;
    }

      // Kartın ve hedef sütunun bu kullanıcının erişebileceği projede olduğunu doğrula
      const card = userCards.find(c => c.id === cardId);
      if (!card) {
        console.log(`[AI PUSH ANALYZER] Kart bulutunda veya kullanıcının kartları arasında bulunamadı: ${cardId}`);
        continue;
      }

      const targetColumn = card.column.project.columns.find(col => col.id === targetColumnId);
      if (!targetColumn) {
        console.log(`[AI PUSH ANALYZER] Hedef sütun bulunamadı: ${targetColumnId}`);
        continue;
      }

      // Zaten o sütundaysa taşıma
      if (card.columnId === targetColumnId) {
        console.log(`[AI PUSH ANALYZER] Kart zaten hedef sütunda ("${targetColumn.name}"), taşıma yapılmadı.`);
        continue;
      }

      // Kartı taşı!
      console.log(`[AI PUSH ANALYZER] Kart taşınıyor! Kart: "${card.title}" -> Hedef Sütun: "${targetColumn.name}" (Gerekçe: ${reason})`);
      await cardService.updateCard(cardId, { columnId: targetColumnId }, userId);
      movedCards.push({
        cardId,
        cardTitle: card.title,
        oldColumn: card.column.name,
        newColumn: targetColumn.name,
        reason
      });
    }

  return { movedCards };
}

export async function testConfiguration(provider: {
  provider: string;
  apiKey: string;
  baseUrl?: string | null;
  model?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const formattedProvider: AIProvider = {
      provider: provider.provider as any,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl || (provider.provider === "google-gemini" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.openai.com/v1"),
      model: provider.model || (provider.provider === "google-gemini" ? "gemini-flash-latest" : "gpt-4o-mini"),
    };

    const messages: ChatMessage[] = [{ role: "user", content: "Hi" }];

    if (formattedProvider.provider === "google-gemini") {
      const { contents, systemInstruction } = toGeminiContents(messages);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const { error } = await callGeminiRaw(
          formattedProvider,
          contents,
          systemInstruction,
          false,
          controller.signal,
        );
        clearTimeout(timeout);
        if (error) {
          return { success: false, error };
        }
        return { success: true };
      } catch (err: any) {
        clearTimeout(timeout);
        return { success: false, error: err?.message || "Gemini connection error" };
      }
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await callOpenAI(formattedProvider, messages, undefined, controller.signal);
        clearTimeout(timeout);
        if (res.content.startsWith("⚠️")) {
          return { success: false, error: res.content };
        }
        return { success: true };
      } catch (err: any) {
        clearTimeout(timeout);
        return { success: false, error: err?.message || "OpenAI connection error" };
      }
    }
  } catch (error: any) {
    return { success: false, error: error?.message || "Bilinmeyen hata" };
  }
}
