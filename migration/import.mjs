import {readFile} from "node:fs/promises";

const [apiUrl, jsonPath] = process.argv.slice(2);
const adminPin = process.env.ADMIN_PIN;
const bootstrapKey = process.env.BOOTSTRAP_KEY;
if (!apiUrl || !jsonPath || !/^\d{4}$/.test(adminPin || "")) {
  console.error("Usage: ADMIN_PIN=1234 node migration/import.mjs https://SITE.web.app/api ./easy-bubble-firebase-export.json");
  process.exit(1);
}
async function call(body) {
  const response = await fetch(apiUrl, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
  const result = await response.json();
  if (!result.success) throw Error(result.message || "Migration request failed");
  return result.data;
}
const data = JSON.parse(await readFile(jsonPath, "utf8"));
let session;
try {
  session = await call({action: "login", pin: adminPin});
} catch (error) {
  if (!bootstrapKey) throw error;
  await call({action: "bootstrap", bootstrap_key: bootstrapKey, admin_pin: adminPin});
  session = await call({action: "login", pin: adminPin});
}
const result = await call({action: "importData", token: session.token, data});
console.log(`Imported ${result.imported} rows successfully.`);
