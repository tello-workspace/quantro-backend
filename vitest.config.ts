import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    // Testler PAYLASILAN uzak Supabase'e baglaniyor: paralel calisirsa
    // ayni anda org/kart olusturup birbirlerinin sayimlarini bozarlar.
    fileParallelism: false,
    // Uzak DB'de her sorgu ~140ms; varsayilan 5sn cok kisa kaliyor.
    testTimeout: 30000,
    hookTimeout: 60000,
    setupFiles: ["./src/test/setup.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
