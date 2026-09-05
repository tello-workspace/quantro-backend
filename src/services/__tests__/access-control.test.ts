import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  checkProjectAccess,
  filterVisibleProjects,
  getVisibleProjectIds,
  assertCanManageProjectAccess,
} from "@/services/access-control.service";
import * as projectService from "@/services/project.service";
import * as changeRequestService from "@/services/change-request.service";
import * as organizationService from "@/services/organization.service";
import * as templateService from "@/services/template.service";
import { ForbiddenError, NotFoundError } from "@/utils/errors";
import { createWorkspace, createUser, createCard, cleanup, uniq } from "@/test/fixtures";

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

async function setVisibility(projectId: string, visibility: "ORG" | "TEAM" | "PRIVATE") {
  await prisma.project.update({ where: { id: projectId }, data: { visibility } });
}

describe("proje gorunurlugu - ORG (varsayilan)", () => {
  it("org uyesi acikca eklenmeden de projeyi gorur", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const access = await checkProjectAccess(ws.project.id, ws.member.id);
    expect(access.role).toBe("MEMBER");
  });

  it("organizasyon disindaki kullanici reddedilir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await expect(checkProjectAccess(ws.project.id, ws.outsider.id)).rejects.toThrow(ForbiddenError);
  });

  it("olmayan proje NotFoundError firlatir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await expect(checkProjectAccess("cmsnonexistentprojectid00", ws.admin.id)).rejects.toThrow(NotFoundError);
  });
});

describe("proje gorunurlugu - TEAM", () => {
  it("ADMIN acikca eklenmeden gorur, MEMBER goremez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    await setVisibility(ws.project.id, "TEAM");

    const adminAccess = await checkProjectAccess(ws.project.id, ws.admin.id);
    expect(adminAccess.role).toBe("ADMIN");

    await expect(checkProjectAccess(ws.project.id, ws.member.id)).rejects.toThrow(ForbiddenError);
  });

  it("acikca eklenen MEMBER projeyi gorebilir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    await setVisibility(ws.project.id, "TEAM");

    await prisma.projectMember.create({ data: { projectId: ws.project.id, userId: ws.member.id } });

    const access = await checkProjectAccess(ws.project.id, ws.member.id);
    expect(access.role).toBe("MEMBER");
  });
});

describe("proje gorunurlugu - PRIVATE", () => {
  it("sahibi disinda ADMIN dahil kimse acikca eklenmeden goremez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    await setVisibility(ws.project.id, "PRIVATE");

    // ws.project sahibi ws.admin - onu disariya ittirmek icin ayri bir
    // proje ve ayri bir sahip (member) kuruyoruz.
    const gizliProje = await prisma.project.create({
      data: {
        name: uniq("gizli-proje"),
        key: "GZL",
        organizationId: ws.org.id,
        ownerId: ws.member.id,
        visibility: "PRIVATE",
      },
    });

    await expect(checkProjectAccess(gizliProje.id, ws.admin.id)).rejects.toThrow(ForbiddenError);

    const sahipErisimi = await checkProjectAccess(gizliProje.id, ws.member.id);
    expect(sahipErisimi.isOwner).toBe(true);
  });

  it("acikca eklenen ADMIN PRIVATE projeyi gorebilir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const gizliProje = await prisma.project.create({
      data: {
        name: uniq("gizli-proje"),
        key: "GZ2",
        organizationId: ws.org.id,
        ownerId: ws.member.id,
        visibility: "PRIVATE",
      },
    });
    await prisma.projectMember.create({ data: { projectId: gizliProje.id, userId: ws.admin.id } });

    const access = await checkProjectAccess(gizliProje.id, ws.admin.id);
    expect(access.role).toBe("ADMIN");
  });
});

describe("GUEST rolu", () => {
  it("GUEST hicbir projeye acikca eklenmeden goremez - ORG gorunurlukte bile", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const guest = await createUser("Guest User");
    userIds.push(guest.id);
    await prisma.organizationMember.create({ data: { organizationId: ws.org.id, userId: guest.id, role: "GUEST" } });

    // ws.project varsayilan ORG gorunurlukte - normalde herkes gorur ama GUEST icin yetmez.
    await expect(checkProjectAccess(ws.project.id, guest.id)).rejects.toThrow(ForbiddenError);
  });

  it("acikca eklenen GUEST sadece o projeyi gorur", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const guest = await createUser("Guest User 2");
    userIds.push(guest.id);
    await prisma.organizationMember.create({ data: { organizationId: ws.org.id, userId: guest.id, role: "GUEST" } });
    await prisma.projectMember.create({ data: { projectId: ws.project.id, userId: guest.id } });

    const access = await checkProjectAccess(ws.project.id, guest.id);
    expect(access.role).toBe("GUEST");

    const ikinciProje = await prisma.project.create({
      data: { name: uniq("ikinci-proje"), key: "IKI", organizationId: ws.org.id, ownerId: ws.admin.id },
    });
    await expect(checkProjectAccess(ikinciProje.id, guest.id)).rejects.toThrow(ForbiddenError);
  });
});

describe("filterVisibleProjects / getVisibleProjectIds", () => {
  it("listeleme ucunda gorunmeyen projeleri eler", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const gizliProje = await prisma.project.create({
      data: {
        name: uniq("gizli-liste"),
        key: "GL1",
        organizationId: ws.org.id,
        ownerId: ws.admin.id,
        visibility: "PRIVATE",
      },
    });

    const visibleIds = await getVisibleProjectIds(ws.org.id, ws.member.id);
    expect(visibleIds.has(ws.project.id)).toBe(true);
    expect(visibleIds.has(gizliProje.id)).toBe(false);

    const projects = await projectService.getProjects(ws.org.id, ws.member.id);
    expect(projects.map((p) => p.id)).not.toContain(gizliProje.id);
  });

  it("organizasyon uyesi olmayan icin bos set doner", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const visibleIds = await getVisibleProjectIds(ws.org.id, ws.outsider.id);
    expect(visibleIds.size).toBe(0);
  });
});

describe("proje erisim yonetimi - visibility/uye ekleme sadece sahip/admin", () => {
  it("sahibi olmayan bir MEMBER gorunurlugu degistiremez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await expect(
      projectService.updateProjectVisibility(ws.project.id, "PRIVATE", ws.member.id)
    ).rejects.toThrow(ForbiddenError);
  });

  it("org admini gorunurlugu degistirebilir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const updated = await projectService.updateProjectVisibility(ws.project.id, "TEAM", ws.admin.id);
    expect(updated.visibility).toBe("TEAM");
  });

  it("admin bir MEMBER'i projeye acikca ekleyebilir, MEMBER kendi kendini ekleyemez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await expect(
      projectService.addProjectMember(ws.project.id, ws.member.id, ws.member.id)
    ).rejects.toThrow(ForbiddenError);

    const added = await projectService.addProjectMember(ws.project.id, ws.member.id, ws.admin.id);
    expect(added.userId).toBe(ws.member.id);
  });

  it("baska organizasyonun uyesi projeye eklenemez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await expect(
      projectService.addProjectMember(ws.project.id, ws.outsider.id, ws.admin.id)
    ).rejects.toThrow(ForbiddenError);
  });

  it("removeProjectMember uyeligi kaldirir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await projectService.addProjectMember(ws.project.id, ws.member.id, ws.admin.id);
    await projectService.removeProjectMember(ws.project.id, ws.member.id, ws.admin.id);

    const kalanlar = await projectService.listProjectMembers(ws.project.id, ws.admin.id);
    expect(kalanlar.map((m) => m.userId)).not.toContain(ws.member.id);
  });
});

describe("assertCanManageProjectAccess", () => {
  it("sahip veya ADMIN olmayanı reddeder", () => {
    expect(() =>
      assertCanManageProjectAccess({
        role: "MEMBER",
        projectId: "x",
        organizationId: "y",
        visibility: "ORG",
        isOwner: false,
      })
    ).toThrow(ForbiddenError);
  });

  it("sahibi MEMBER olsa bile gecer", () => {
    expect(() =>
      assertCanManageProjectAccess({
        role: "MEMBER",
        projectId: "x",
        organizationId: "y",
        visibility: "ORG",
        isOwner: true,
      })
    ).not.toThrow();
  });
});

// Yukaridaki testlerin hepsi checkProjectAccess'i ZATEN cagiran yollar
// uzerinden kosuyordu; gorunurluk kuralini BAYPAS eden uclar (talep acma,
// org detayindaki proje listesi, sablon listeleme, uye cikarma sonrasi kalan
// ProjectMember artigi) hic test edilmiyordu. O yollar duzeltildi ama
// regresyon testi olmadigi icin sessizce tekrar kirilabilirdi - asagidaki
// testler tam olarak o dort yolu kilitliyor.
describe("gorunurluk kuralini baypas eden uclar - regresyon", () => {
  // (a) Talep akisi panoyu okumakla ayni gorunurluk kapisindan gecmeli:
  // kart/sutun id'sini bilmek tek basina talep acmaya yetmemeli.
  it("GUEST goremedigi projedeki karta CARD_DELETE talebi acamaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const guest = await createUser("Guest Talep");
    userIds.push(guest.id);
    await prisma.organizationMember.create({
      data: { organizationId: ws.org.id, userId: guest.id, role: "GUEST" },
    });

    const kart = await createCard(ws.todo.id, ws.admin.id, "Gizli kart");

    // GUEST org uyesi ama ProjectMember degil -> projeyi hic goremez
    await expect(
      changeRequestService.createRequest(
        { type: "CARD_DELETE", targetCardId: kart.id, payload: {} },
        guest.id
      )
    ).rejects.toThrow(ForbiddenError);

    // Ayni kart icin projeyi GOREBILEN uye talep acabiliyor olmali - aksi
    // halde test yalnizca "her sey reddediliyor" diyerek bos gecerdi.
    const talep = await changeRequestService.createRequest(
      { type: "CARD_DELETE", targetCardId: kart.id, payload: {} },
      ws.member.id
    );
    expect(talep.status).toBe("PENDING");
  });

  it("MEMBER eklenmedigi PRIVATE projedeki karta CARD_UPDATE talebi acamaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const gizliProje = await prisma.project.create({
      data: {
        name: uniq("gizli-talep"),
        key: "GTL",
        organizationId: ws.org.id,
        ownerId: ws.admin.id,
        visibility: "PRIVATE",
      },
    });
    const gizliSutun = await prisma.column.create({
      data: { projectId: gizliProje.id, name: "To Do", position: 1 },
    });
    const gizliKart = await createCard(gizliSutun.id, ws.admin.id, "Gizli proje karti");

    await expect(
      changeRequestService.createRequest(
        { type: "CARD_UPDATE", targetCardId: gizliKart.id, payload: { title: "Yeni" } },
        ws.member.id
      )
    ).rejects.toThrow(ForbiddenError);
  });

  // (b) Org detay ucu once TUM projeleri filtresiz donduruyordu; GUEST'e
  // erisemedigi projelerin adi/aciklamasi siziyordu.
  it("getOrganizationById GUEST'e yalnizca acikca eklendigi projeyi doner", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const guest = await createUser("Guest Org Detay");
    userIds.push(guest.id);
    await prisma.organizationMember.create({
      data: { organizationId: ws.org.id, userId: guest.id, role: "GUEST" },
    });
    await prisma.projectMember.create({ data: { projectId: ws.project.id, userId: guest.id } });

    const digerProje = await prisma.project.create({
      data: { name: uniq("guest-disi"), key: "GDS", organizationId: ws.org.id, ownerId: ws.admin.id },
    });

    const org = await organizationService.getOrganizationById(ws.org.id, guest.id);
    const projeIdleri = org.projects.map((p) => p.id);
    expect(projeIdleri).toContain(ws.project.id);
    expect(projeIdleri).not.toContain(digerProje.id);
  });

  // (c) Sablon uclari eskiden yalnizca "org uyesi mi" diye bakiyordu: PRIVATE
  // bir projenin sablon adlari/basliklari/checklist maddeleri org'daki herkese
  // aciliyordu.
  it("listTemplates goremedigi PRIVATE projede ADMIN'i bile reddeder", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const gizliProje = await prisma.project.create({
      data: {
        name: uniq("gizli-sablon"),
        key: "GSB",
        organizationId: ws.org.id,
        ownerId: ws.member.id,
        visibility: "PRIVATE",
      },
    });
    await prisma.cardTemplate.create({
      data: {
        projectId: gizliProje.id,
        name: uniq("sablon"),
        title: "Gizli sablon basligi",
        checklistItems: ["gizli madde"],
        createdById: ws.member.id,
      },
    });

    // ADMIN, PRIVATE projeye ProjectMember olarak eklenmedigi icin goremez
    await expect(templateService.listTemplates(gizliProje.id, ws.admin.id)).rejects.toThrow(
      ForbiddenError
    );

    // Sahibi icin uc calisiyor olmali - yoksa test "sablon yok" diye bos gecerdi
    const sahipListesi = await templateService.listTemplates(gizliProje.id, ws.member.id);
    expect(sahipListesi).toHaveLength(1);
  });

  // (d) OrganizationMember silinirken ProjectMember satirlari kaliyordu; kisi
  // ileride tekrar davet edilince checkProjectAccess o eski satiri bulup
  // PRIVATE projeye erisimi sessizce geri veriyordu.
  it("removeMember ProjectMember artigi birakmaz, tekrar uye olmak erisimi geri getirmez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await projectService.addProjectMember(ws.project.id, ws.member.id, ws.admin.id);
    await setVisibility(ws.project.id, "PRIVATE");

    // Once erisimi var oldugunu dogrula (aksi halde asagisi anlamsiz olurdu)
    const oncekiErisim = await checkProjectAccess(ws.project.id, ws.member.id);
    expect(oncekiErisim.role).toBe("MEMBER");

    await organizationService.removeMember(ws.org.id, ws.member.id, ws.admin.id);

    const kalanProjectMember = await prisma.projectMember.count({
      where: { userId: ws.member.id, project: { organizationId: ws.org.id } },
    });
    expect(kalanProjectMember).toBe(0);

    // Tekrar davet edilip kabul etmis gibi org uyeligini geri veriyoruz:
    // PRIVATE projeye erisim GERI GELMEMELI.
    await prisma.organizationMember.create({
      data: { organizationId: ws.org.id, userId: ws.member.id, role: "MEMBER" },
    });
    await expect(checkProjectAccess(ws.project.id, ws.member.id)).rejects.toThrow(ForbiddenError);
  });
});
