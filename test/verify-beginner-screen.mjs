#!/usr/bin/env node
import { readFileSync } from "node:fs";

const browser = readFileSync(new URL("../src/project-browser.jsx", import.meta.url), "utf8");
const guide = readFileSync(new URL("../src/first-success-guide.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/project-browser.css", import.meta.url), "utf8");
let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

expect("start screen has the v2 region root", browser.includes('className={`v2-start-screen project-browser-backdrop'));
expect("start screen has the four navigation destinations", ["Recent", "New Project", "Samples", "Learn"].every((label) => browser.includes(`label: ko("${label}"`)));
expect("start screen exposes the template grid and category tabs", browser.includes("v2-start-template-grid") && browser.includes("v2-start-tabs") && browser.includes("CATEGORIES"));
expect("start screen exposes the name and storage fields", browser.includes('data-testid="start-project-name"') && browser.includes('ko("Location"') && browser.includes('ko("Frame rate"') && browser.includes('ko("Units"'));
expect("empty project names disable Create with a reason title", browser.includes("disabled={!canCreate}") && browser.includes("createReason"));
expect("the first-success guide keeps its v2 region root", guide.includes('className="v2-first-success-guide first-success-guide"'));
expect("all new visual rules are rooted in the v2 regions", css.includes(".v2-start-screen") && css.includes(".v2-first-success-guide") && !/^\.(project-browser|first-success-guide)/m.test(css));
expect("the v2 screen keeps the fixed 232px and 340px columns", css.includes("var(--start-nav-width, 232px)") && css.includes("var(--start-preview-width, 340px)"));

if (failures) process.exitCode = 1;
else console.log("all v2 start-screen checks PASS");
