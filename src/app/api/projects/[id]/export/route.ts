import { NextRequest } from "next/server";
import * as boardService from "@/services/board.service";
import { errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

type BoardTask = {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  startDate: string | null;
  columnId: string;
  position: number;
  priority: string;
  lastActivityAt: string;
  assignees: { id: string; name: string }[];
  labels: { id: string; name: string; color: string }[];
  checklistTotal: number;
  checklistDone: number;
};

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Board verisini CSV olarak serialize eder. Kolon adi her satirda, kartlar
// tek tek satirlar halinde (kolon -> kart listesi). getBoard'un dönüs tipi
// Record<string, unknown> oldugu icin gecerli BoardTask alanlarina tip
// guvenli erisim icin helper kullanilir.
function boardToCsv(board: { columns: Record<string, { id: string; title: string; wipLimit: number | null; isDone: boolean; taskIds: string[] }>; tasks: Record<string, Partial<BoardTask>> }): string {
  const header = "column,card_id,title,priority,due_date,assignees,labels,checklist,description";
  const rows: string[] = [header];

  for (const col of Object.values(board.columns)) {
    for (const taskId of col.taskIds) {
      const task = board.tasks[taskId] as Partial<BoardTask> | undefined;
      if (!task) continue;
      rows.push(
        [
          csvEscape(col.title),
          csvEscape(task.id),
          csvEscape(task.title),
          csvEscape(task.priority),
          csvEscape(task.dueDate),
          csvEscape(task.assignees?.map((a) => a.name).join("; ")),
          csvEscape(task.labels?.map((l) => l.name).join("; ")),
          `${task.checklistDone ?? 0}/${task.checklistTotal ?? 0}`,
          csvEscape(task.description),
        ].join(","),
      );
    }
  }

  return rows.join("\n");
}

// Board'u disari aktar: ?format=csv | json (varsayilan json).
// Yedekleme, raporlama ve bazi gecis islemleri icin - salt okunur.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const format = searchParams.get("format") ?? "json";

    const board = await boardService.getBoard(id, user.id);

    if (format === "csv") {
      const csv = boardToCsv(board as { columns: Record<string, { id: string; title: string; wipLimit: number | null; isDone: boolean; taskIds: string[] }>; tasks: Record<string, Partial<BoardTask>> });
      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="board-${id}.csv"`,
        },
      });
    }

    // JSON format
    return new Response(JSON.stringify(board, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="board-${id}.json"`,
      },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Board dışa aktarılamadı");
  }
}
