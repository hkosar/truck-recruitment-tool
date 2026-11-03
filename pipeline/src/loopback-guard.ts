// Source guard for the loopback-only HTTP tests. This file exists twice, byte-identical, in
// app/server/testing/ and pipeline/src/ (scripts/verify-loopback-fetch-contract.mjs keeps them identical).
//
// It parses a test file (TypeScript syntax tree, so comments, strings and spacing cannot fool it) and
// reports every way the file could reach the network outside loopback-fetch.ts:
//   - the global fetch, however spelled (fetch(...), fetch (...), globalThis.fetch, globalThis['fetch'], const f = fetch);
//   - node:http request()/get(), imported by name, aliased, or through a namespace/default import: every call
//     must pass an inline options object holding agent: loopbackAgent() (no variable options, no spread);
//   - ClientRequest, dynamic import()/require() of an HTTP module (a computed module name is not checked), and imports of other HTTP clients
//     (https, http2, undici, axios, ...).

import ts from 'typescript';

const HTTP_MODULES = new Set(['node:http', 'http']);
const BANNED_MODULES = new Set(['node:https', 'https', 'node:http2', 'http2', 'undici', 'axios', 'node-fetch', 'got', 'ky', 'superagent']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window']);
const REQUEST_FUNCTIONS = new Set(['request', 'get']);

function isLoopbackAgentCall(node: ts.Expression): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'loopbackAgent' && node.arguments.length === 0;
}

/** True when the call has an inline options object with agent: loopbackAgent() and no spread that could override it. */
function hasPrivateAgent(call: ts.CallExpression): boolean {
  return call.arguments.some((arg) => {
    if (!ts.isObjectLiteralExpression(arg)) return false;
    if (arg.properties.some((p) => ts.isSpreadAssignment(p))) return false;
    return arg.properties.some((p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'agent' && isLoopbackAgentCall(p.initializer));
  });
}

function inTypePosition(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (ts.isTypeNode(n)) return true;
  return false;
}

export function findLoopbackViolations(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const report = (node: ts.Node, message: string) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push(`${fileName}:${line + 1}: ${message}`);
  };

  const requestNames = new Set<string>(); // local names bound to node:http request/get
  const namespaces = new Set<string>(); // local names bound to the whole node:http module
  let agentImported = false;
  const specifierOf = (n: ts.Node) => (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : undefined);

  for (const statement of file.statements) {
    const spec = specifierOf(statement);
    if (spec === undefined || !ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (BANNED_MODULES.has(spec)) report(statement, `imports ${spec}, which this guard cannot check`);
    if (HTTP_MODULES.has(spec)) {
      if (statement.importClause?.name) namespaces.add(statement.importClause.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) if (REQUEST_FUNCTIONS.has((el.propertyName ?? el.name).text)) requestNames.add(el.name.text);
      }
    }
    if (/(^|\/)loopback-fetch(\.js|\.ts)?$/.test(spec) && bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) if ((el.propertyName ?? el.name).text === 'loopbackAgent' && el.name.text === 'loopbackAgent') agentImported = true;
    }
  }

  const checkCall = (call: ts.CallExpression, what: string) => {
    if (!hasPrivateAgent(call)) report(call, `${what}() must pass an inline options object with agent: loopbackAgent()`);
    if (!agentImported) report(call, `${what}() needs loopbackAgent imported from loopback-fetch`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportEqualsDeclaration(node)) report(node, 'import = require() cannot be checked');
    if (ts.isCallExpression(node)) {
      const loader = node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic import()' : ts.isIdentifier(node.expression) && node.expression.text === 'require' ? 'require()' : undefined;
      const arg = node.arguments[0];
      // Loading a product file or a script (even by a computed path) is fine; naming an HTTP module here is not.
      if (loader && arg && ts.isStringLiteralLike(arg) && (HTTP_MODULES.has(arg.text) || BANNED_MODULES.has(arg.text))) report(node, `${loader} of ${arg.text} cannot be checked`);
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isMemberName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node) || (ts.isMethodDeclaration(parent) && parent.name === node) || (ts.isPropertySignature(parent) && parent.name === node);
      if (node.text === 'fetch' && !inTypePosition(node) && !isMemberName) report(node, 'uses the global fetch; use loopbackFetch');
      if (node.text === 'ClientRequest' && !inTypePosition(node)) report(node, 'uses ClientRequest directly');
      const isMemberOwner = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
      if (namespaces.has(node.text) && !ts.isImportClause(parent) && !ts.isNamespaceImport(parent) && !isMemberOwner && !inTypePosition(node) && !isMemberName) report(node, `${node.text} (node:http) is used other than as ${node.text}.member`);
      if (requestNames.has(node.text) && !ts.isImportSpecifier(parent) && !inTypePosition(node) && !isMemberName) {
        if (ts.isCallExpression(parent) && parent.expression === node) checkCall(parent, node.text);
        else report(node, `${node.text} (node:http) is used other than by a direct call`);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'fetch' && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text)) report(node, `${node.expression.text}.fetch is the global fetch; use loopbackFetch`);
      if (ts.isIdentifier(node.expression) && namespaces.has(node.expression.text) && REQUEST_FUNCTIONS.has(node.name.text)) {
        if (ts.isCallExpression(node.parent) && node.parent.expression === node) checkCall(node.parent, `${node.expression.text}.${node.name.text}`);
        else report(node, `${node.expression.text}.${node.name.text} is used other than by a direct call`);
      }
      if (ts.isIdentifier(node.expression) && namespaces.has(node.expression.text) && node.name.text === 'ClientRequest') report(node, 'uses ClientRequest directly');
    }
    if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      const text = ts.isStringLiteralLike(arg) ? arg.text : undefined;
      if (text === 'fetch') report(node, "['fetch'] is the global fetch; use loopbackFetch");
      if (ts.isIdentifier(node.expression) && namespaces.has(node.expression.text) && (text === undefined || REQUEST_FUNCTIONS.has(text) || text === 'ClientRequest')) report(node, 'computed access on node:http cannot be checked');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
