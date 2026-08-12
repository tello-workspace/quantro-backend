import { z } from "zod";

export const importFormatSchema = z.enum(["TRELLO_JSON", "JIRA_CSV"]);

// 5MB metin sinirlamasi: board export'lari genelde birkac yuz KB, buyuk bir
// Trello panosu bile checklist/uye dahil birkac MB'i gecmiyor.
export const previewImportSchema = z.object({
  format: importFormatSchema,
  fileContent: z.string().min(1).max(5_000_000),
});

const columnMappingEntrySchema = z.union([
  z.object({ mode: z.literal("existing"), columnId: z.string() }),
  z.object({ mode: z.literal("new"), name: z.string().min(1).max(100) }),
  z.object({ mode: z.literal("skip") }),
]);

export const applyImportSchema = z.object({
  format: importFormatSchema,
  fileContent: z.string().min(1).max(5_000_000),
  columnMapping: z.record(z.string(), columnMappingEntrySchema),
  userMapping: z.record(z.string(), z.string().nullable()),
});

export type ColumnMappingEntry = z.infer<typeof columnMappingEntrySchema>;
export type PreviewImportInput = z.infer<typeof previewImportSchema>;
export type ApplyImportInput = z.infer<typeof applyImportSchema>;
