import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, createUser, uniq, cleanup } from "@/test/fixtures";
import { prisma } from "@/lib/prisma";
import * as projectService from "@/services/project.service";
import * as orgService from "@/services/organization.service";
import { ForbiddenError, ConflictError } from "@/utils/errors";

// Proje + organizasyon RBAC testleri:
// - Proje olusturma sadece org ADMIN'ine (varsayilan 4 kolon acilir)
// - Davet gonderimi sadece admin'e; uye davet edemez
// - Uye rol degistirme sadece admin'e
// - Org olusturma herkese acik (kayitli kullanici)
// - Davet kabul: baskasinin davetini kabul edemezsin

describe("project.service RBAC", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("ADMIN proje olusturur, varsayilan 4 kolon acilir", async () => {
    const { admin, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const project = await projectService.createProject(org.id, { name: "Yeni proje" }, admin.id);
    expect(project.columns.length).toBe(4);
    expect(project.columns.map((c) => c.name)).toEqual(["To Do", "In Progress", "Testing", "Done"]);

    const done = project.columns.find((c) => c.name === "Done");
    expect(done?.isDone).toBe(true);
  });

  it("MEMBER proje olusturamaz (ForbiddenError)", async () => {
    const { member, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(member.id);

    await expect(
      projectService.createProject(org.id, { name: "X" }, member.id),
    ).rejects.toThrow(ForbiddenError);
  });

  it("outsider org'a ait projeleri goremez (ForbiddenError)", async () => {
    const { outsider, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(outsider.id);

    await expect(projectService.getProjects(org.id, outsider.id)).rejects.toThrow(ForbiddenError);
  });
});

describe("organization.service RBAC", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("kayitli kullanici org olusturabilir", async () => {
    const owner = await createUser("Org Sahibi");
    userIds.push(owner.id);

    const org = await orgService.createOrganization({ name: uniq("org") }, owner.id);
    orgIds.push(org.id);

    expect(org.name).toBe(org.name);
    expect(org.ownerId).toBe(owner.id);

    // Sahip otomatik ADMIN uyesi mi?
    const member = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: owner.id } },
    });
    expect(member?.role).toBe("ADMIN");
  });

  it("MEMBER davet gonderemez (ForbiddenError)", async () => {
    const { member, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(member.id);

    const target = await createUser("Davet edilecek");
    userIds.push(target.id);

    await expect(
      orgService.inviteMember(org.id, { email: target.email }, member.id),
    ).rejects.toThrow(ForbiddenError);
  });

  it("ADMIN davet gonderebilir", async () => {
    const { admin, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const target = await createUser("Davet edilecek");
    userIds.push(target.id);

    const invitation = await orgService.inviteMember(org.id, { email: target.email }, admin.id);
    expect(invitation).toMatchObject({ organizationId: org.id, invitedUserId: target.id, status: "PENDING" });
  });

  it("uyeye tekrar davet -> ConflictError", async () => {
    const { admin, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const target = await createUser("Davet edilecek");
    userIds.push(target.id);

    await orgService.inviteMember(org.id, { email: target.email }, admin.id);
    await expect(
      orgService.inviteMember(org.id, { email: target.email }, admin.id),
    ).rejects.toThrow(ConflictError);
  });

  it("baskasinin davetini kabul edemezsin (ForbiddenError)", async () => {
    const { admin, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const target = await createUser("Davet edilecek");
    const other = await createUser("Baskasi");
    userIds.push(target.id, other.id);

    const invitation = await orgService.inviteMember(org.id, { email: target.email }, admin.id);

    await expect(orgService.acceptInvitation(invitation.id, other.id)).rejects.toThrow(ForbiddenError);
  });

  it("MEMBER uye rolunu degistiremez (ForbiddenError)", async () => {
    const { admin, member, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    const target = await createUser("Rolu degisecek");
    userIds.push(target.id);
    await orgService.inviteMember(org.id, { email: target.email }, admin.id);

    // target daveti kabul etsin
    const invitation = await prisma.organizationInvitation.findFirst({
      where: { organizationId: org.id, invitedUserId: target.id, status: "PENDING" },
    });
    await orgService.acceptInvitation(invitation!.id, target.id);

    await expect(
      orgService.updateMemberRole(org.id, { userId: target.id, role: "MEMBER" }, member.id),
    ).rejects.toThrow(ForbiddenError);
  });
});
