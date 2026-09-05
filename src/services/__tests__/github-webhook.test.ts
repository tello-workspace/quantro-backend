import { describe, it, expect, afterAll } from "vitest";
import crypto from "node:crypto";
import { extractCardKeys, branchAdiCikar, handleEvent } from "@/services/github-webhook.service";
import { githubImzasiDogrula, webhookSecretUret } from "@/utils/github-signature";
import { prisma } from "@/lib/prisma";
import { createWorkspace, createCard, cleanup, uniq } from "@/test/fixtures";
import type { GithubRepoLink } from "@prisma/client";

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

// ─── Saf fonksiyonlar (DB'ye gitmez) ────────────────────────────────────

describe("extractCardKeys", () => {
  it("dal adindan ve commit mesajlarindan anahtar cikarir", () => {
    expect(extractCardKeys("feat/QNT-42-mail-zinciri")).toEqual(["QNT-42"]);
    expect(extractCardKeys("QNT-1 ve QNT-2 duzeltildi")).toEqual(["QNT-1", "QNT-2"]);
  });

  it("kucuk harfli yazimi buyuk harfe normalize eder", () => {
    // Gelistirici dal adini kucuk harfle yazabilmeli - git dal adlarinda
    // kucuk harf yaygin bir konvansiyon.
    expect(extractCardKeys("fix/qnt-7-hata")).toEqual(["QNT-7"]);
  });

  it("ayni anahtar birden fazla gecerse tek kez doner", () => {
    expect(extractCardKeys("QNT-42 baslangic", "QNT-42 devam", "qnt-42 bitis")).toEqual(["QNT-42"]);
  });

  it("gecersiz bicimleri reddeder", () => {
    // 6 karakterlik onek: proje anahtari en fazla 5 karakter.
    expect(extractCardKeys("ABCDEF-1")).toEqual([]);
    // Rakamla baslayan onek yok.
    expect(extractCardKeys("1ST-4")).toEqual([]);
    // Numara sifir olamaz.
    expect(extractCardKeys("QNT-0")).toEqual([]);
    // Tek karakterlik onek yok (regex en az 2 istiyor).
    expect(extractCardKeys("Q-5")).toEqual([]);
    expect(extractCardKeys("")).toEqual([]);
    expect(extractCardKeys(null, undefined)).toEqual([]);
  });

  it("kelime sinirlarina uyar, gercek anahtari calmaz", () => {
    // Rakamdan sonra harf gelirse anahtar degil: "QNT-42x" bir surum/kod
    // parcasi olabilir, kart referansi degil.
    expect(extractCardKeys("QNT-42x")).toEqual([]);

    // "xQNT-42" ise bicim olarak GECERLI bir anahtar - oneki "XQNT". Onemli
    // olan, regex'in soldaki harfi atlayip gercek projenin onekini ("QNT")
    // yakalamamasi: aksi halde ilgisiz bir kelime gercek bir karti tasirdi.
    // Boyle bir proje anahtari yoksa kart aramasi bos doner, zarari olmaz.
    expect(extractCardKeys("xQNT-42")).toEqual(["XQNT-42"]);

    // "UTF-8" de bicimsel olarak gecerli; ayni gerekceyle zararsiz.
    expect(extractCardKeys("UTF-8 kodlamasi")).toEqual(["UTF-8"]);
  });

  it("anahtar sayisini tavanda kirpar", () => {
    const cokFazla = Array.from({ length: 40 }, (_, i) => `QNT-${i + 1}`).join(" ");
    expect(extractCardKeys(cokFazla)).toHaveLength(20);
  });
});

describe("branchAdiCikar", () => {
  it("refs/heads onekini atar", () => {
    expect(branchAdiCikar("refs/heads/feat/QNT-42")).toBe("feat/QNT-42");
  });

  it("etiket ve diger ref turlerini reddeder", () => {
    // Etiket push'u is baslatmaz.
    expect(branchAdiCikar("refs/tags/v1.0.0")).toBeNull();
    expect(branchAdiCikar(undefined)).toBeNull();
    expect(branchAdiCikar("refs/heads/")).toBeNull();
  });
});

describe("githubImzasiDogrula", () => {
  const secret = "test-secret";
  const govde = JSON.stringify({ merhaba: "dunya" });
  const gecerliImza =
    "sha256=" + crypto.createHmac("sha256", secret).update(govde, "utf8").digest("hex");

  it("dogru imzayi kabul eder", () => {
    expect(githubImzasiDogrula(govde, gecerliImza, secret)).toBe(true);
  });

  it("govde degisince reddeder", () => {
    expect(githubImzasiDogrula(govde + " ", gecerliImza, secret)).toBe(false);
  });

  it("yanlis secret ile uretilmis imzayi reddeder", () => {
    expect(githubImzasiDogrula(govde, gecerliImza, "baska-secret")).toBe(false);
  });

  it("eksik ya da bicimsiz basligi reddeder", () => {
    expect(githubImzasiDogrula(govde, null, secret)).toBe(false);
    expect(githubImzasiDogrula(govde, "", secret)).toBe(false);
    // sha1 eski surum - kabul edilmemeli.
    expect(githubImzasiDogrula(govde, "sha1=abc", secret)).toBe(false);
    // Onek dogru ama uzunluk tutmuyor: timingSafeEqual'i patlatmamali.
    expect(githubImzasiDogrula(govde, "sha256=kisa", secret)).toBe(false);
  });

  it("uretilen secret her cagrida farkli ve yeterince uzun", () => {
    const a = webhookSecretUret();
    const b = webhookSecretUret();
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64); // 32 bayt hex
  });
});

// ─── Olay isleme (DB'ye gider) ──────────────────────────────────────────

/** Test icin depo bagi olusturur. */
async function linkOlustur(
  projectId: string,
  createdById: string,
  kolonlar: Partial<Pick<GithubRepoLink, "branchColumnId" | "prOpenColumnId" | "prMergedColumnId">> = {},
) {
  return prisma.githubRepoLink.create({
    data: {
      projectId,
      owner: "merto",
      repo: uniq("repo"),
      secret: webhookSecretUret(),
      createdById,
      ...kolonlar,
    },
  });
}

function pushYuku(branch: string, commitMesajlari: string[] = [], senderLogin = "merto") {
  return {
    ref: `refs/heads/${branch}`,
    commits: commitMesajlari.map((message) => ({ message })),
    repository: { default_branch: "main", html_url: "https://github.com/merto/repo" },
    sender: { login: senderLogin },
  };
}

function prYuku(action: string, branch: string, opts: { merged?: boolean; number?: number } = {}) {
  return {
    action,
    pull_request: {
      number: opts.number ?? 17,
      title: "Mail zinciri",
      body: "",
      html_url: "https://github.com/merto/repo/pull/17",
      merged: opts.merged ?? false,
      state: action === "closed" ? "closed" : "open",
      head: { ref: branch },
      user: { login: "merto" },
    },
    repository: { html_url: "https://github.com/merto/repo" },
    sender: { login: "merto" },
  };
}

async function kartinKolonu(cardId: string) {
  const kart = await prisma.card.findUniqueOrThrow({
    where: { id: cardId },
    select: { columnId: true },
  });
  return kart.columnId;
}

describe("handleEvent - olay/kolon eslemesi", () => {
  it("dal push'u karti 'branch' kolonuna tasir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const inProgress = await prisma.column.create({
      data: { projectId: ws.project.id, name: "In Progress", position: 1.5 },
    });
    const kart = await createCard(ws.todo.id, ws.admin.id, "Mail zinciri");
    const link = await linkOlustur(ws.project.id, ws.admin.id, { branchColumnId: inProgress.id });

    const sonuc = await handleEvent({
      link,
      event: "push",
      deliveryId: uniq("delivery"),
      payload: pushYuku(`feat/TST-${kart.number}-mail`),
    });

    expect(sonuc.islendi).toBe(true);
    expect(sonuc.tasinanKartlar).toEqual([`TST-${kart.number}`]);
    expect(await kartinKolonu(kart.id)).toBe(inProgress.id);
  });

  it("varsayilan dala push kartlari geri cekmez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const inProgress = await prisma.column.create({
      data: { projectId: ws.project.id, name: "In Progress", position: 1.5 },
    });
    const kart = await createCard(ws.todo.id, ws.admin.id);
    const link = await linkOlustur(ws.project.id, ws.admin.id, { branchColumnId: inProgress.id });

    // main'e merge sonrasi push geliyor; kart Done'a gitmisken "In Progress"e
    // geri cekilmemeli - merge'in kendisi pull_request olayindan geliyor.
    const sonuc = await handleEvent({
      link,
      event: "push",
      deliveryId: uniq("delivery"),
      payload: pushYuku("main", [`TST-${kart.number} tamamlandi`]),
    });

    expect(sonuc.islendi).toBe(false);
    expect(sonuc.not).toBe("varsayilan dal");
    expect(await kartinKolonu(kart.id)).toBe(ws.todo.id);
  });

  it("PR acilinca 'inceleme', merge edilince 'bitti' kolonuna tasir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const review = await prisma.column.create({
      data: { projectId: ws.project.id, name: "In Review", position: 1.5 },
    });
    const kart = await createCard(ws.todo.id, ws.admin.id);
    const link = await linkOlustur(ws.project.id, ws.admin.id, {
      prOpenColumnId: review.id,
      prMergedColumnId: ws.done.id,
    });
    const branch = `feat/TST-${kart.number}-x`;

    const acildi = await handleEvent({
      link,
      event: "pull_request",
      deliveryId: uniq("delivery"),
      payload: prYuku("opened", branch),
    });
    expect(acildi.islendi).toBe(true);
    expect(await kartinKolonu(kart.id)).toBe(review.id);

    const merged = await handleEvent({
      link,
      event: "pull_request",
      deliveryId: uniq("delivery"),
      payload: prYuku("closed", branch, { merged: true }),
    });
    expect(merged.tasinanKartlar).toEqual([`TST-${kart.number}`]);
    expect(await kartinKolonu(kart.id)).toBe(ws.done.id);

    // PR bagi kartta rozet olarak gorunecek; durumu "merged" olmali.
    const bag = await prisma.githubCardLink.findFirstOrThrow({
      where: { cardId: kart.id, kind: "PULL_REQUEST" },
    });
    expect(bag.state).toBe("merged");
    expect(bag.reference).toBe("17");
    // Iki tam olay isliyor (acilma + merge), her biri tasima + bildirim
    // uretiyor; uzak DB'de 30sn'lik varsayilan yetmiyor.
  }, 60000);

  it("merge edilmeden kapanan PR karti tasimaz ama durumu gunceller", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const kart = await createCard(ws.todo.id, ws.admin.id);
    const link = await linkOlustur(ws.project.id, ws.admin.id, { prMergedColumnId: ws.done.id });

    const sonuc = await handleEvent({
      link,
      event: "pull_request",
      deliveryId: uniq("delivery"),
      payload: prYuku("closed", `feat/TST-${kart.number}`, { merged: false }),
    });

    expect(sonuc.tasinanKartlar).toEqual([]);
    expect(await kartinKolonu(kart.id)).toBe(ws.todo.id);

    const bag = await prisma.githubCardLink.findFirstOrThrow({ where: { cardId: kart.id } });
    expect(bag.state).toBe("closed");
  });

  it("kolon eslenmemisse tasimaz ama bagi yine kaydeder", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const kart = await createCard(ws.todo.id, ws.admin.id);
    // Hicbir kolon eslenmemis: ozellik "yalnizca bagi goster" modunda.
    const link = await linkOlustur(ws.project.id, ws.admin.id);

    await handleEvent({
      link,
      event: "push",
      deliveryId: uniq("delivery"),
      payload: pushYuku(`feat/TST-${kart.number}-x`),
    });

    expect(await kartinKolonu(kart.id)).toBe(ws.todo.id);
    const bag = await prisma.githubCardLink.findFirst({ where: { cardId: kart.id, kind: "BRANCH" } });
    expect(bag).not.toBeNull();
  });
});

describe("handleEvent - guvenlik ve dayaniklilik", () => {
  it("KIRACI SINIRI: baska projenin kartini tasimaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    // AYNI organizasyonda ikinci bir proje. findCardByKey org kapsaminda
    // arama yaptigi icin, kontrol olmasa bir depo digerinin kartlarini
    // commit mesajina anahtar yazarak oynatabilirdi.
    const digerProje = await prisma.project.create({
      data: { name: uniq("diger"), key: "OTH", organizationId: ws.org.id, ownerId: ws.admin.id },
    });
    const digerTodo = await prisma.column.create({
      data: { projectId: digerProje.id, name: "To Do", position: 1 },
    });
    const yabanciKart = await createCard(digerTodo.id, ws.admin.id, "Yabanci kart");

    const inProgress = await prisma.column.create({
      data: { projectId: ws.project.id, name: "In Progress", position: 1.5 },
    });
    const link = await linkOlustur(ws.project.id, ws.admin.id, { branchColumnId: inProgress.id });

    const sonuc = await handleEvent({
      link,
      event: "push",
      deliveryId: uniq("delivery"),
      payload: pushYuku(`feat/OTH-${yabanciKart.number}-sizinti`),
    });

    expect(sonuc.tasinanKartlar).toEqual([]);
    // Yabanci kart yerinde durmali.
    expect(await kartinKolonu(yabanciKart.id)).toBe(digerTodo.id);
    // Bag da kurulmamali - kart detayinda ilgisiz bir depo gorunmemeli.
    expect(await prisma.githubCardLink.count({ where: { cardId: yabanciKart.id } })).toBe(0);
  });

  it("ayni teslimat ikinci kez gelirse islenmez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const inProgress = await prisma.column.create({
      data: { projectId: ws.project.id, name: "In Progress", position: 1.5 },
    });
    const kart = await createCard(ws.todo.id, ws.admin.id);
    const link = await linkOlustur(ws.project.id, ws.admin.id, { branchColumnId: inProgress.id });

    const deliveryId = uniq("delivery");
    const yuk = pushYuku(`feat/TST-${kart.number}-x`);

    const ilk = await handleEvent({ link, event: "push", deliveryId, payload: yuk });
    expect(ilk.islendi).toBe(true);

    // Kullanici GitHub'da "Redeliver" dedi: kart geri tasinmis olsa bile
    // ikinci kez islenmemeli.
    await prisma.card.update({ where: { id: kart.id }, data: { columnId: ws.todo.id } });
    const ikinci = await handleEvent({ link, event: "push", deliveryId, payload: yuk });

    expect(ikinci.islendi).toBe(false);
    expect(ikinci.not).toBe("tekrar teslimat");
    expect(await kartinKolonu(kart.id)).toBe(ws.todo.id);
  });

  it("arsivlenmis karti diriltmez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const kart = await createCard(ws.todo.id, ws.admin.id);
    await prisma.card.update({ where: { id: kart.id }, data: { isArchived: true } });
    const link = await linkOlustur(ws.project.id, ws.admin.id, { prMergedColumnId: ws.done.id });

    const sonuc = await handleEvent({
      link,
      event: "pull_request",
      deliveryId: uniq("delivery"),
      payload: prYuku("closed", `feat/TST-${kart.number}`, { merged: true }),
    });

    expect(sonuc.not).toBe("kart bulunamadi");
    expect(await kartinKolonu(kart.id)).toBe(ws.todo.id);
  });

  it("ping olayini basariyla yanitlar, desteklenmeyeni yok sayar", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const link = await linkOlustur(ws.project.id, ws.admin.id);

    // Webhook kaydedilirken GitHub bir kez "ping" atiyor; kullanicinin
    // kurulum ekraninda yesil tik gormesi buna bagli.
    const ping = await handleEvent({ link, event: "ping", deliveryId: uniq("d"), payload: {} });
    expect(ping.islendi).toBe(true);

    const ilgisiz = await handleEvent({ link, event: "issues", deliveryId: uniq("d"), payload: {} });
    expect(ilgisiz.islendi).toBe(false);
  });

  it("gecis kurallari ENFORCE ise tasimaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    // Atanani olmayan kart bu kolona giremez. Otomatik yol da kullanicinin
    // surukleyerek yapamayacagi gecisi yapmamali.
    const kilitli = await prisma.column.create({
      data: {
        projectId: ws.project.id,
        name: "In Review",
        position: 1.5,
        transitionMode: "ENFORCE",
        requireAssignee: true,
      },
    });
    const kart = await createCard(ws.todo.id, ws.admin.id);
    const link = await linkOlustur(ws.project.id, ws.admin.id, { prOpenColumnId: kilitli.id });

    const sonuc = await handleEvent({
      link,
      event: "pull_request",
      deliveryId: uniq("delivery"),
      payload: prYuku("opened", `feat/TST-${kart.number}`),
    });

    expect(sonuc.tasinanKartlar).toEqual([]);
    expect(await kartinKolonu(kart.id)).toBe(ws.todo.id);
  });
});
