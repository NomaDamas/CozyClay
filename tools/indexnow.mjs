// Post-deploy: tell IndexNow (Bing, Yandex, Naver, Seznam and friends) which
// URLs just changed. Google does not use IndexNow; it still reads the sitemap.
// The key is public by design: search engines verify it by fetching
// https://cozyclay.org/<key>.txt. Usage: node tools/indexnow.mjs [url ...]
// With no arguments it submits every URL in the live sitemap.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HOST = "cozyclay.org";
const key = readFileSync(resolve(import.meta.dirname, "indexnow.key"), "utf8").trim();
let urls = process.argv.slice(2);
if (urls.length === 0) {
	const xml = await (await fetch(`https://${HOST}/sitemap.xml`)).text();
	urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}
const response = await fetch("https://api.indexnow.org/indexnow", {
	method: "POST",
	headers: { "content-type": "application/json; charset=utf-8" },
	body: JSON.stringify({ host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList: urls }),
});
console.log(`indexnow: ${response.status} for ${urls.length} url(s)`);
if (response.status >= 400) process.exit(1);
