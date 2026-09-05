import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ValidationError } from "@/utils/errors";
import { checkMembership } from "@/services/project.service";
import { checkProjectAccess } from "@/services/access-control.service";

export interface TemplateColumn {
  name: string;
  position: number;
  wipLimit?: number | null;
  isDone?: boolean;
}

export interface TemplateLabel {
  name: string;
  color: string;
}

// Hazir sablonlar - DB'de degil, kodda. Ekstra migration/seed senkronu
// gerektirmiyor ve "hazir birkac sablon" ihtiyacini (kartin kendi istegi)
// sifir bakim maliyetiyle karsiliyor. id "builtin:" ile basliyor - DB
// tablosundaki cuid'lerle asla cakismaz, resolveTemplate bu onekle ayirt eder.
export const BUILTIN_TEMPLATES: {
  id: string;
  name: string;
  columns: TemplateColumn[];
  labels: TemplateLabel[];
}[] = [
  {
    id: "builtin:software",
    name: "Yazılım Geliştirme",
    columns: [
      { name: "To Do", position: 1 },
      { name: "In Progress", position: 2 },
      { name: "Testing", position: 3 },
      { name: "Done", position: 4, isDone: true },
      { name: "Suggestions", position: 5 },
    ],
    labels: [
      { name: "bug", color: "#EF4444" },
      { name: "feature", color: "#3B82F6" },
      { name: "kolay", color: "#22C55E" },
    ],
  },
  {
    id: "builtin:simple",
    name: "Basit Kanban",
    columns: [
      { name: "To Do", position: 1 },
      { name: "In Progress", position: 2 },
      { name: "Done", position: 3, isDone: true },
    ],
    labels: [],
  },
];

export async function listProjectTemplates(organizationId: string, userId: string) {
  const member = await checkMembership(organizationId, userId);
  if (!member) throw new ForbiddenError("Bu organizasyonun üyesi değilsiniz");

  const custom = await prisma.projectTemplate.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  return {
    builtin: BUILTIN_TEMPLATES.map((t) => ({ id: t.id, name: t.name, columnCount: t.columns.length, labelCount: t.labels.length })),
    custom: custom.map((t) => ({
      id: t.id,
      name: t.name,
      columnCount: (t.columns as unknown as TemplateColumn[]).length,
      labelCount: (t.labels as unknown as TemplateLabel[]).length,
      createdBy: t.createdBy,
    })),
  };
}

// Mevcut bir projenin kolon+etiket yapisini sablon olarak kaydeder.
// Kartlar BILEREK haric - sablon "yapi" demek, "veri" degil.
export async function createProjectTemplateFromProject(projectId: string, name: string, userId: string) {
  // Gorunurluk kurali bu yolda da gecerli olmali. Onceden proje dogrudan
  // ID ile okunup yalnizca org ADMIN'ligi dogrulaniyordu; oysa access-control
  // kuralina gore ADMIN, ProjectMember olmadigi PRIVATE bir projeyi goremez.
  // Bu yuzden goremedigi projenin kolon/WIP/etiket yapisi org geneline acik
  // bir ProjectTemplate olarak disari cikarilabiliyordu. Once erisim, sonra
  // okuma: checkProjectAccess proje yoksa NotFoundError, erisim yoksa
  // ForbiddenError firlatir.
  const access = await checkProjectAccess(projectId, userId);
  if (access.role !== "ADMIN") {
    throw new ForbiddenError("Sadece adminler şablon oluşturabilir");
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      organizationId: true,
      columns: { select: { name: true, position: true, wipLimit: true, isDone: true }, orderBy: { position: "asc" } },
      labels: { select: { name: true, color: true } },
    },
  });
  if (!project) throw new NotFoundError("Proje");

  return prisma.projectTemplate.create({
    data: {
      organizationId: project.organizationId,
      name,
      columns: project.columns,
      labels: project.labels,
      createdById: userId,
    },
  });
}

export async function deleteProjectTemplate(templateId: string, userId: string) {
  const template = await prisma.projectTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw new NotFoundError("Şablon");

  const member = await checkMembership(template.organizationId, userId);
  if (!member || member.role !== "ADMIN") {
    throw new ForbiddenError("Sadece adminler şablon silebilir");
  }

  await prisma.projectTemplate.delete({ where: { id: templateId } });
}

// createProject icin: templateId verilmemisse null doner (cagiran varsayilan
// 4 koluna duser - mevcut davranis degismiyor).
export async function resolveTemplate(
  templateId: string | undefined,
  organizationId: string,
): Promise<{ columns: TemplateColumn[]; labels: TemplateLabel[] } | null> {
  if (!templateId) return null;

  if (templateId.startsWith("builtin:")) {
    const builtin = BUILTIN_TEMPLATES.find((t) => t.id === templateId);
    if (!builtin) throw new ValidationError("Geçersiz şablon");
    return { columns: builtin.columns, labels: builtin.labels };
  }

  const custom = await prisma.projectTemplate.findUnique({ where: { id: templateId } });
  if (!custom || custom.organizationId !== organizationId) {
    throw new NotFoundError("Şablon");
  }
  return {
    columns: custom.columns as unknown as TemplateColumn[],
    labels: custom.labels as unknown as TemplateLabel[],
  };
}
