import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";
import * as dependencyService from "@/services/dependency.service";
import { ValidationError, ConflictError, ForbiddenError, NotFoundError } from "@/utils/errors";

// Bagimlilik servisi: dongu tespiti en kritik is mantigi.
// A -> B -> C -> A zincirinin eklenmesi ValidationError ("dongu olusturur")
// ile reddedilir. Ayrica ayni proje kontrolu, self-relation, duplicate.

async function createTwoCards(todoId: string, adminId: string) {
  const a = await createCard(todoId, adminId, "A");
  const b = await createCard(todoId, adminId, "B");
  const c = await createCard(todoId, adminId, "C");
  return { a, b, c };
}

describe("dependency.service dongu tespiti", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("A->B bagimliligi eklenir", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const { a, b } = await createTwoCards(todo.id, admin.id);

    const dep = await dependencyService.addDependency(a.id, b.id, admin.id);
    expect(dep).toMatchObject({ blockedId: a.id, blockerId: b.id });
  });

  it("A->B->C->A dongu olusturur ve reddedilir", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const { a, b, c } = await createTwoCards(todo.id, admin.id);

    // A -> B, B -> C eklensin
    await dependencyService.addDependency(a.id, b.id, admin.id);
    await dependencyService.addDependency(b.id, c.id, admin.id);

    // C -> A eklersen dongu kapanir: A -> B -> C -> A
    await expect(
      dependencyService.addDependency(c.id, a.id, admin.id),
    ).rejects.toThrow(ValidationError);
  });

  it("kart kendisiyle iliskilendirilemez", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const { a } = await createTwoCards(todo.id, admin.id);

    await expect(
      dependencyService.addDependency(a.id, a.id, admin.id),
    ).rejects.toThrow(ValidationError);
  });

  it("ayni bagimlilik iki kez eklenemez (ConflictError)", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const { a, b } = await createTwoCards(todo.id, admin.id);

    await dependencyService.addDependency(a.id, b.id, admin.id);
    await expect(
      dependencyService.addDependency(a.id, b.id, admin.id),
    ).rejects.toThrow(ConflictError);
  });

  it("outsider bagimlilik ekleyemez (ForbiddenError)", async () => {
    const { outsider, org, todo, admin } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, outsider.id);
    const { a, b } = await createTwoCards(todo.id, admin.id);

    await expect(dependencyService.addDependency(a.id, b.id, outsider.id)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("olmayan kart icin NotFoundError firlatir", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const { a } = await createTwoCards(todo.id, admin.id);

    await expect(dependencyService.addDependency(a.id, "olmayan-kart", admin.id)).rejects.toThrow(
      NotFoundError,
    );
  });
});
