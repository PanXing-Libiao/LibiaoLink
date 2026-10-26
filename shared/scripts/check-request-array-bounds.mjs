import { buildOpenApiDocument } from "../src/openapi.ts";

const doc = buildOpenApiDocument();
const schemas = doc.components?.schemas ?? {};
const methods = ["get", "post", "put", "patch", "delete", "options", "head"];
const violations = [];
let scannedArrays = 0;

function resolveSchema(schema) {
  let current = schema;
  const seenRefs = new Set();
  while (current?.$ref?.startsWith("#/components/schemas/")) {
    if (seenRefs.has(current.$ref)) break;
    seenRefs.add(current.$ref);
    const name = current.$ref.slice("#/components/schemas/".length);
    current = schemas[name];
  }
  return current;
}

function isArraySchema(schema) {
  return schema.type === "array" || (Array.isArray(schema.type) && schema.type.includes("array"));
}

function scan(schema, location, pointer = "", seen = new Set()) {
  schema = resolveSchema(schema);
  if (!schema || typeof schema !== "object" || seen.has(schema)) return;
  seen.add(schema);

  if (isArraySchema(schema)) {
    scannedArrays += 1;
    if (!Number.isInteger(schema.maxItems) || schema.maxItems < 0) {
      violations.push({ location, pointer: pointer || "(root)" });
    }
  }

  if (schema.items) scan(schema.items, location, pointer + "/items", seen);
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    scan(value, location, pointer + "/properties/" + key, seen);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    for (const [index, value] of (schema[key] ?? []).entries()) {
      scan(value, location, pointer + "/" + key + "/" + index, seen);
    }
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    scan(schema.additionalProperties, location, pointer + "/additionalProperties", seen);
  }
}

for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
  for (const method of methods) {
    const operation = pathItem[method];
    if (!operation) continue;
    const location = method.toUpperCase() + " " + path;
    const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
    for (const [index, parameter] of parameters.entries()) {
      scan(parameter.schema, location + " 参数", "/parameters/" + (parameter.name ?? index));
    }
    for (const [mediaType, media] of Object.entries(operation.requestBody?.content ?? {})) {
      scan(media.schema, location + " 请求体 " + mediaType);
    }
  }
}

if (violations.length > 0) {
  console.error("请求数组长度上限检查失败：发现 " + violations.length + " 个请求数组未声明 maxItems。");
  for (const violation of violations) {
    console.error("- " + violation.location + " " + violation.pointer);
  }
  process.exit(1);
}

console.log("请求数组长度上限检查通过：扫描 " + scannedArrays + " 个请求数组，全部声明 maxItems。");
