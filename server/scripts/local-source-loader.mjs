// Development only: transpile requested server/contracts modules, including Nest metadata.
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const serverSource = new URL("../src/", import.meta.url).href;
const sharedSource = new URL("../../shared/src/", import.meta.url).href;
const serverDist = new URL("../dist/", import.meta.url).href;
const databaseSource = new URL("../../database/", import.meta.url).href;
const isSource = (url) => url.startsWith(serverSource) || url.startsWith(sharedSource);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@libiaolink/contracts") return { url: sharedSource + "index.ts", shortCircuit: true };
    if (specifier === "pg" && context.parentURL?.startsWith(databaseSource)) return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    if ((specifier.startsWith(".") || specifier.startsWith("file:")) && context.parentURL) {
      const candidate = new URL(specifier, context.parentURL).href;
      if (candidate.startsWith(serverDist) && candidate.endsWith(".js")) {
        const source = serverSource + candidate.slice(serverDist.length, -3) + ".ts";
        if (existsSync(fileURLToPath(source))) return { url: source, shortCircuit: true };
      }
      if (isSource(candidate) && candidate.endsWith(".js")) {
        const source = candidate.slice(0, -3) + ".ts";
        if (existsSync(fileURLToPath(source))) return { url: source, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!isSource(url) || !url.endsWith(".ts")) return nextLoad(url, context);
    const result = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      fileName: fileURLToPath(url),
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true,
        verbatimModuleSyntax: true,
        inlineSourceMap: true,
        inlineSources: true,
      },
    });
    return { format: "module", source: result.outputText, shortCircuit: true };
  },
});
