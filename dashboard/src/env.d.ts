// Augments the auto-generated CloudflareEnv with D1 binding.
// Run `npm run cf-typegen` to regenerate cloudflare-env.d.ts after wrangler picks up the binding.
declare namespace Cloudflare {
	interface Env {
		DB: D1Database;
	}
}
interface CloudflareEnv {
	DB: D1Database;
}
