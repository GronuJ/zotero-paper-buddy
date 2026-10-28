// Builds build/<slug>-<version>.xpi and build/update.json from addon/.
// Usage: node scripts/build.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const REPO = process.env.GITHUB_REPOSITORY || "GronuJ/zotero-paper-buddy";
const SLUG = "zotero-paper-buddy";

const manifest = JSON.parse(readFileSync("addon/manifest.json", "utf8"));
const { version } = manifest;
const zotero = manifest.applications.zotero;
const xpiName = `${SLUG}-${version}.xpi`;

rmSync("build", { recursive: true, force: true });
mkdirSync("build");
execFileSync("zip", ["-qr", "-X", `../build/${xpiName}`, "."], { cwd: "addon", stdio: "inherit" });

const hash = createHash("sha256").update(readFileSync(`build/${xpiName}`)).digest("hex");
const update = {
	addons: {
		[zotero.id]: {
			updates: [{
				version,
				update_link: `https://github.com/${REPO}/releases/download/v${version}/${xpiName}`,
				update_hash: `sha256:${hash}`,
				applications: {
					zotero: {
						strict_min_version: zotero.strict_min_version,
						strict_max_version: zotero.strict_max_version,
					},
				},
			}],
		},
	},
};
writeFileSync("build/update.json", JSON.stringify(update, null, 2) + "\n");
console.log(`Built build/${xpiName} and build/update.json`);
