#!/usr/bin/env node
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const hierarchy = readFileSync(new URL("../src/hierarchy-panel.jsx", import.meta.url), "utf8");
const browser = readFileSync(new URL("../src/project-browser.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

expect("startup chooser has one primary create action", browser.includes('className="btn primary beginner-create"') && browser.includes("Create a project"));
expect("startup chooser offers project open", browser.includes('className="btn ghost beginner-open"') && browser.includes("Open a project"));
expect("startup chooser explains the three-step path", browser.includes("beginner-step-grid") && browser.includes('>1</b>') && browser.includes('>2</b>') && browser.includes('>3</b>'));
expect("beginner hierarchy keeps characters and removes rig rows", hierarchy.includes("beginnerMode = false") && hierarchy.includes("Beginner mode keeps the cast") && hierarchy.includes("map(({ children, ...character }) => character)"));
expect("Studio always opens with the full authoring surface", app.includes("const advancedMode = true;") && !app.includes("advanced-toggle"));
expect("beginner chooser has responsive step cards", css.includes(".beginner-step-grid") && css.includes("grid-template-columns: repeat(3"));

if (failures) process.exitCode = 1;
else console.log("all beginner first-screen checks PASS");
