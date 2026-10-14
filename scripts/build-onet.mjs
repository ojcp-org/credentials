// Builds data/onet/soc-2019.json from the O*NET Resource Center's published files
// (data/onet/source). Every SDK loads the same JSON, so containment is identical
// across languages. Run: node scripts/build-onet.mjs
import { readFileSync, writeFileSync } from "node:fs";

function parseCsv(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v !== ""));
}

const structure = parseCsv(readFileSync("data/onet/source/SOC_Structure.csv", "utf8")).slice(1);
const occupations = parseCsv(readFileSync("data/onet/source/2019_Occupations.csv", "utf8")).slice(
  1,
);

// node: code -> { t: title, p: parent code | null }
const nodes = {};
const stack = [null, null, null, null, null];
for (const [major, minor, broad, detailed, onet, title] of structure) {
  const level = [major, minor, broad, detailed, onet].findIndex((v) => v !== "");
  const code = [major, minor, broad, detailed, onet][level];
  let parent = null;
  for (let l = level - 1; l >= 0; l--)
    if (stack[l]) {
      parent = stack[l];
      break;
    }
  nodes[code] = { t: title, p: parent };
  stack[level] = code;
  for (let l = level + 1; l < stack.length; l++) stack[l] = null;
}

const listed = {};
for (const [code, title] of occupations) {
  listed[code] = title;
  if (code.endsWith(".00")) {
    const detailed = code.slice(0, 7);
    if (!nodes[detailed]) throw new Error(`no SOC detailed occupation for ${code}`);
  } else if (!nodes[code]) {
    throw new Error(`O*NET code ${code} missing from structure`);
  }
}

const out = {
  taxonomy: "https://www.onetcenter.org/taxonomy/2019/list.html",
  source:
    "O*NET-SOC 2019 Taxonomy and SOC structure, O*NET Resource Center (onetcenter.org), CC BY 4.0",
  occupations: listed,
  structure: nodes,
};
for (const path of ["data/onet/soc-2019.json", "sdks/typescript/core/src/onet/soc-2019.json"])
  writeFileSync(path, `${JSON.stringify(out)}\n`);
const residual = Object.values(listed).filter((t) => /All Other$/.test(t)).length;
console.log(
  `occupations=${Object.keys(listed).length} structure_nodes=${Object.keys(nodes).length} residual=${residual}`,
);
