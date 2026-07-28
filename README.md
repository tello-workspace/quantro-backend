# tello-backend

Proaktif görev yönetim aracı backend.

- **Framework:** Next.js 15 (App Router)
- **ORM:** Prisma + PostgreSQL
- **Auth:** JWT + bcrypt
- **Validation:** Zod
- **Realtime:** Socket.IO (custom `server.ts`)

```bash
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

## Git Çakışması Erken Uyarı

Aynı dosyaya **farklı kartlar** üzerinden dokunan iki geliştirici tespit edilince,
daha kimse commit atmadan panoda uyarı çıkar.

**Akış:** VSCode extension'da bir karta sağ tıklayıp "Bu Kart Üzerinde Çalışıyorum"
denir → extension dosya kaydettiğinde (`onSave`) veya aktif editör değiştiğinde
backend'e `presence:file` gönderir → backend aynı dosyada farklı kartla çalışan
başka biri varsa ilgili proje odalarına `conflict:detected` yayınlar → panoda
kartların üzerinde turuncu uyarı rozeti ve kart detayında uyarı bandı belirir.

Çakışma haritası process belleğinde tutulur (Redis/DB yok) ve dosya
seviyesindedir — satır/hunk analizi yapılmaz, yani **kesin çakışma değil risk
sinyalidir**. Arayüzdeki dil de buna göre yazılmıştır.

### Testi (sunum için)

İki ayrı VSCode penceresi açmadan, iki kullanıcıyı taklit ederek uçtan uca test eder:

```bash
npm run dev          # ayrı bir terminalde açık kalmalı
npm run test:conflict
```

Beklenen çıktı: sonda iki adet `[!] conflict:detected alindi:` bloğu
(A ve B tarafı için), içinde `filePath`, `cardA/cardB` ve `userA/userB` alanları.

Arayüzü de görmek istersen scripti çalıştırmadan önce panoyu tarayıcıda açık
tut — rozetler sayfa yenilemeden anında belirir.

Varsayılan olarak `prisma/seed.ts`'teki demo kullanıcıları kullanır
(`mehmet@tello.demo` / `zeynep@tello.demo`, şifre `demo1234`). Kendi
hesaplarınla denemek için: `USER_A_EMAIL`, `USER_A_PASSWORD`, `USER_B_EMAIL`,
`USER_B_PASSWORD` ortam değişkenlerini ver (iki hesap da aynı organizasyon ve
projede olmalı, projede en az 2 kart bulunmalı).

> **Dikkat:** `npm run dev` watch modunda çalışmaz. `src/server/socket.ts`'i
> değiştirdiysen sunucuyu yeniden başlatmadan test etme — eski kod bellekte
> kalır ve `presence:file` eventi sessizce yok sayılır.
