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

**Uyarı ne zaman kalkar?** Taraflardan biri başka bir dosyaya geçince, VSCode'u
kapatınca veya "Kart Takibini Bırak" deyince `conflict:resolved` yayınlanır ve
rozet sayfa yenilenmeden kaybolur. Ayrıca **15 dakikadır** yeni sinyal
gelmemiş kayıtlar bayat sayılır: VSCode'u açık bırakıp giden birinin kaydı
sonsuza kadar durup ertesi gün yanlış alarm üretmesin diye 5 dakikada bir
taranıp temizlenir.

### Testi (sunum için)

İki ayrı VSCode penceresi açmadan, iki kullanıcıyı taklit ederek uçtan uca test eder:

```bash
npm run dev          # ayrı bir terminalde açık kalmalı
npm run test:conflict
```

Beklenen çıktı:
1. 5. adımdan sonra iki adet `[!] conflict:detected alindi:` bloğu (A ve B için),
   içinde `filePath`, `cardA/cardB` ve `userA/userB` alanları
2. 6. adımdan sonra (B başka dosyaya geçer) iki adet `[ok] conflict:resolved
   alindi:` bloğu, içinde `filePath` ve `cardIds`

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

> **Dikkat:** Aynı anda **tek bir backend** çalıştır. Veritabanı takımca
> paylaşılan bir Supabase pooler'ı ve session limiti 15 bağlantı; ikinci bir
> instance açmak havuzu tüketip `EMAXCONNSESSION` ile herkesin sorgularını
> düşürür. Test için ikinci sunucu açmak yerine mevcut olanı yeniden başlat.
