export async function register() {
  // Edge runtime'da node-cron calismaz, sadece Node.js runtime'da baslat
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startCronJobs } = await import("@/lib/cron");
    startCronJobs();
  }
}
