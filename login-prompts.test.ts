import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");

test("login prompts keep all field names visible while users type", () => {
	assert.match(indexSource, /baseUrl:\s*"New API 登录（1\/3）：网站地址"/);
	assert.match(indexSource, /userId:\s*"New API 登录（2\/3）：用户 ID"/);
	assert.match(indexSource, /accessToken:\s*"New API 登录（3\/3）：系统访问令牌"/);
	assert.match(indexSource, /ctx\.ui\.input\(\s*LOGIN_PROMPT_TITLES\.baseUrl,/);
	assert.match(indexSource, /ctx\.ui\.input\(LOGIN_PROMPT_TITLES\.userId\)/);
	assert.match(indexSource, /theme\.fg\("accent", `\$\{LOGIN_PROMPT_TITLES\.accessToken\}  `\)/);
});

test("access token prompt renders only a length-preserving mask", () => {
	assert.match(indexSource, /const masked = "\*"\.repeat\(input\.getValue\(\)\.length\);/);
	assert.match(indexSource, /truncateToWidth\(label \+ masked, width\)/);
	assert.doesNotMatch(indexSource, /truncateToWidth\(label \+ input\.getValue\(\), width\)/);
});
