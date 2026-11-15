// NodeSourceReader. Reads the server timeouts
// of a Node program from its source, with ts-morph, without running anything:
// the source is parsed into a syntax tree and walked; nothing is evaluated,
// required or imported.
//
// Decisions, each kept where it is made:
// - A value is a numeric literal (digit separators, hex, exponent) or a
//   product of literals, in parentheses or under a type wrapper. Anything else
//   is unresolved with a fixed reason (never a guess).
// - A setting is read from an assignment `x.name = v` / `x['name'] = v` (any
//   receiver: there is no type information), from an options object given to a
//   `createServer(...)` call, and from an object literal given to `Object.assign`.
// - An options argument that is a plain identifier is followed to a `const`
//   whose initializer is an object literal in the same file. If it cannot be
//   classified and is not the only argument, the four settings are unresolved
//   (the options could hold any of them). A sole unclassifiable identifier is
//   taken as the request handler (`createServer(app)`); that is an assumption
//   (see docs/limits.md).
// - A construction site counts only when it is an http or https `createServer`
//   (also `node:http`), or a `.listen(...)` on an Express app (`express()` from the
//   `express` package) or on a server traced to one of those. A `.listen` on anything
//   else is a server framework tripcurve does not read (`framework-not-read`): no
//   framework's defaults are written into the tool.
// - The search is incomplete (a gap) when code outside what was read could set the
//   timeouts: a `require` or `import()` with a computed argument, or the server
//   value handed to a function from a module that is not a local file or a Node
//   built-in. Preload flags and `NODE_OPTIONS` are the linker's input (`NodePreloads`).
// - TypeScript never throws on bad syntax: a file with a syntax error is
//   reported `parse-error` and nothing is read from it. A file is first parsed
//   as TSX, then as TS, so a JSX file and a `<T>x` assertion file both parse.
// - A stack overflow while parsing or walking is `over-depth`; any other
//   failure is `parse-error`. Both are caught at the file boundary.

import { builtinModules } from 'node:module';
import { Node, Project, ScriptKind, type SourceFile, ts } from 'ts-morph';
import {
  fileSource,
  type InputText,
  inputText,
  makeSourcedValue,
  type SourceRef,
  type UnresolvedValue,
} from '../../core/index.js';
import {
  type InputFile,
  type IntakeResult,
  rawInputTextForParser,
  rawTextForParser,
  type UncheckedInput,
} from '../intake/index.js';
import { type ReaderUnresolved, UnresolvedLog } from '../reader-result.js';
import { evalLiteral, statementOf, unwrap } from './ast-helpers.js';
import {
  NODE_DRAIN_GAPS,
  NODE_SEARCH_GAPS,
  NODE_SETTING_NAMES,
  type NodeDrain,
  type NodeDrainGap,
  type NodeFileReading,
  type NodePreloads,
  type NodeSearchGap,
  type NodeServerSettings,
  type NodeSettingName,
  type NodeSettingValue,
} from './model.js';
import { DRAIN_HINT, DrainReader } from './read-node-drains.js';
import { isShutdownLibrary, packageNameOf } from './shutdown-libraries.js';

const NAME_SET: ReadonlySet<string> = new Set(NODE_SETTING_NAMES);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.mts', '.cts'] as const;
// Extensions a relative import can carry that are not source we read (data or styles).
const NON_SOURCE_EXTENSIONS = ['.json', '.css', '.scss', '.html', '.node', '.wasm', '.txt'];

export const LABEL_NON_LITERAL = 'set from something other than a number written in the code';
export const LABEL_UNSUPPORTED_FORM = 'set in a form tripcurve does not read';
export const LABEL_AMBIGUOUS = 'set to different values in different places';
export const LABEL_NEGATIVE_OR_ODD = 'written as a number that cannot be a timeout';
const DECLARE_HINT = 'write the number in the code, for example server.keepAliveTimeout = 65000';

const HTTP_MODULES: ReadonlySet<string> = new Set(['http', 'https', 'node:http', 'node:https']);
const BUILTINS: ReadonlySet<string> = new Set(builtinModules);
/** A built-in module takes no part in setting a server's timeouts when a server is handed to it. */
function isBuiltinSpecifier(spec: string): boolean {
  return spec.startsWith('node:') || BUILTINS.has(spec);
}
function isLocalSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}
/** Packages whose use is READ as a drain (read-node-drains.ts): importing them is not a gap by itself. */
const READ_PACKAGES: ReadonlySet<string> = new Set(['@godaddy/terminus', 'lightship']);
const MAX_TRACE_DEPTH = 8;
const REFERENCE_NAMES: ReadonlySet<string> = new Set([
  'eval',
  'Function',
  'Reflect',
  'defineProperty',
  'defineProperties',
  'setPrototypeOf',
]);
const REFERENCE_KEYS: ReadonlySet<string> = new Set([
  'constructor',
  'defineProperty',
  'defineProperties',
  'setPrototypeOf',
]);
const TIMERS: ReadonlySet<string> = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const VM_MODULES: ReadonlySet<string> = new Set(['vm', 'node:vm']);
/** A name assigned this many times is not traced (it is not a server tripcurve can name); bounds the work on hostile input. */
const MAX_DEFS_PER_NAME = 32;

function isSetting(name: string): name is NodeSettingName {
  return NAME_SET.has(name);
}

// ---------------------------------------------------------------- one file

type Found = {
  name: NodeSettingName;
  value: NodeSettingValue;
  source: SourceRef;
};

/** How a setting was written: by assignment (or Object.assign) on a receiver, or in the options of a createServer call. */
type Origin =
  | { readonly kind: 'assign'; readonly at: Node; readonly receiver: Node | undefined }
  | { readonly kind: 'options'; readonly create: Node | undefined };

type Trace = 'server' | 'app';

export class FileWalk {
  readonly found: Found[] = [];
  /** Where each setting was written: an assignment (and the object it was written on) or a `createServer` options literal. */
  private readonly origins = new Map<Found, Origin>();
  /** The `createServer` call whose arguments are being read, so its options know which server they configure. */
  private activeCreate: Node | undefined;
  /** True when a `createServer` of `https` is read: its idle close was not measured. */
  usesHttps = false;
  /** Local names bound to the `https` module, and to `createServer` of `https`. */
  private readonly httpsModules = new Set<string>();
  private readonly httpsCreateFns = new Set<string>();
  /** Every `.listen(...)` call on something traced to a server or an app. */
  private readonly listenCalls: Node[] = [];
  readonly log = new UnresolvedLog();
  site: SourceRef | undefined;
  readonly imports: { specifier: InputText; line: number }[] = [];
  readonly gaps = new Set<NodeSearchGap>();
  /** Lines of `require(...)` or `import(...)` with an argument that is not a literal. */
  readonly dynamicLoads: number[] = [];
  /** Why the drain search of this file is incomplete. */
  readonly drainGaps = new Set<NodeDrainGap>();

  // What the file binds, found before the walk (a use can come before its import in source order).
  /** Local names bound to the `http` or `https` module. */
  private readonly httpModules = new Set<string>();
  /** Local names bound to `createServer` of `http` or `https`. */
  private readonly createServerFns = new Set<string>();
  // Names bound to the modules whose use makes an in-process drain (read by `DrainReader`).
  private readonly lightshipFns = new Set<string>();
  private readonly lightshipModules = new Set<string>();
  private readonly terminusFns = new Set<string>();
  private readonly terminusModules = new Set<string>();
  private readonly processNames = new Set<string>(['process']);
  private readonly timerFns = new Set<string>();
  private readonly timerModules = new Set<string>();
  /** Local names bound to the `express` function. */
  private readonly expressFns = new Set<string>();
  /** Local name to the module it came from, for every import and require binding. */
  private readonly importedFrom = new Map<string, string>();
  /** Local name to the relative module and member it was imported as (`default` for a default import or a whole require). */
  private readonly importedLocal = new Map<string, { specifier: string; member: string }>();
  /** Local imports used as the request handler of `createServer`: each must be an Express app there. */
  readonly handlerImports: { specifier: string; member: string; line: number }[] = [];
  /** What this file exports that traces to an `express()` call: `default`, `module.exports`, or a name. */
  readonly exportedApps = new Set<string>();
  private identIndex: Map<string, Node[]> | undefined;
  private declIndex: { vars: Node[]; funcs: Node[] } | undefined;
  /** Source text of a name (`server`, `this.server`) to every expression assigned to it. */
  readonly defs = new Map<string, Node[]>();
  private readonly traceMemo = new Map<string, Trace | undefined>();

  constructor(
    private readonly path: InputText,
    readonly sf: SourceFile,
  ) {}

  /** Offsets of the first character of each line, built once (ts-morph's getStartLineNumber rescans the text for every node). */
  private lineStarts: number[] | undefined;

  /** The 1-based line a node starts on (as getStartLineNumber: a line break is `\n`), in logarithmic time. */
  private lineOf(node: Node): number {
    if (this.lineStarts === undefined) {
      const text = this.sf.getFullText();
      const starts = [0];
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
      this.lineStarts = starts;
    }
    const pos = node.getStart();
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] as number) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  src(node: Node): SourceRef {
    return fileSource(this.path, this.lineOf(node));
  }

  // ------------------------------------------------------------ bindings

  private bindModule(local: string, spec: string, member: string | undefined): void {
    this.importedFrom.set(local, spec);
    if (isLocalSpecifier(spec)) {
      this.importedLocal.set(local, { specifier: spec, member: member ?? 'default' });
    }
    if (HTTP_MODULES.has(spec)) {
      const https = spec === 'https' || spec === 'node:https';
      if (member === undefined) {
        this.httpModules.add(local);
        if (https) this.httpsModules.add(local);
      } else if (member === 'createServer') {
        this.createServerFns.add(local);
        if (https) this.httpsCreateFns.add(local);
      }
    } else if (spec === 'express' && (member === undefined || member === 'default')) {
      this.expressFns.add(local);
    } else if (spec === 'lightship') {
      if (member === 'createLightship') this.lightshipFns.add(local);
      else if (member === undefined || member === 'default') this.lightshipModules.add(local);
    } else if (spec === '@godaddy/terminus') {
      if (member === 'createTerminus') this.terminusFns.add(local);
      else if (member === undefined || member === 'default') this.terminusModules.add(local);
    } else if (spec === 'process' || spec === 'node:process') {
      if (member === undefined || member === 'default') this.processNames.add(local);
    } else if (spec === 'timers/promises' || spec === 'node:timers/promises') {
      if (member === 'setTimeout') this.timerFns.add(local);
      else if (member === undefined) this.timerModules.add(local);
    }
  }

  /** `require('x')` with a literal argument: the specifier, else undefined. */
  private requireSpecifier(node: Node | undefined): string | undefined {
    if (node === undefined || !Node.isCallExpression(node)) return undefined;
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee) || callee.getText() !== 'require') return undefined;
    const arg = node.getArguments()[0];
    return arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))
      ? arg.getLiteralValue()
      : undefined;
  }

  private collectBindings(node: Node): void {
    if (Node.isImportDeclaration(node)) {
      const spec = node.getModuleSpecifierValue();
      const def = node.getDefaultImport();
      if (def) this.bindModule(def.getText(), spec, undefined);
      const ns = node.getNamespaceImport();
      if (ns) this.bindModule(ns.getText(), spec, undefined);
      for (const named of node.getNamedImports()) {
        const local = (named.getAliasNode() ?? named.getNameNode()).getText();
        this.bindModule(local, spec, named.getName());
      }
    } else if (Node.isImportEqualsDeclaration(node)) {
      const ref = node.getModuleReference();
      if (Node.isExternalModuleReference(ref)) {
        const expr = ref.getExpression();
        if (expr && Node.isStringLiteral(expr)) {
          this.bindModule(node.getName(), expr.getLiteralValue(), undefined);
        }
      }
    } else if (Node.isVariableDeclaration(node)) {
      const init = node.getInitializer();
      const nameNode = node.getNameNode();
      const spec = this.requireSpecifier(unwrap(init));
      if (spec !== undefined && Node.isIdentifier(nameNode)) {
        this.bindModule(nameNode.getText(), spec, undefined);
      } else if (spec !== undefined && Node.isObjectBindingPattern(nameNode)) {
        for (const el of nameNode.getElements()) {
          const member = (el.getPropertyNameNode() ?? el.getNameNode()).getText();
          this.bindModule(el.getNameNode().getText(), spec, member);
        }
      }
      if (init) this.addDef(nameNode.getText(), init);
    } else if (Node.isBinaryExpression(node)) {
      if (node.getOperatorToken().getKind() === ts.SyntaxKind.EqualsToken) {
        const left = node.getLeft();
        if (Node.isIdentifier(left) || this.isThisAccess(left)) {
          this.addDef(left.getText(), node.getRight());
        }
      }
    } else if (Node.isPropertyDeclaration(node)) {
      const init = node.getInitializer();
      if (init) this.addDef(`this.${node.getName()}`, init);
    }
  }

  private isThisAccess(node: Node): boolean {
    return (
      Node.isPropertyAccessExpression(node) &&
      node.getExpression().getKind() === ts.SyntaxKind.ThisKeyword
    );
  }

  private addDef(key: string, expr: Node): void {
    const list = this.defs.get(key);
    if (list === undefined) this.defs.set(key, [expr]);
    else list.push(expr);
  }

  // ------------------------------------------------------------ what a value is

  /** `http.createServer(...)`, `createServer(...)` from http or https, `require('http').createServer(...)`. */
  private isHttpCreateServer(call: Node): boolean {
    if (!Node.isCallExpression(call)) return false;
    const callee = call.getExpression();
    if (Node.isIdentifier(callee)) {
      if (!this.createServerFns.has(callee.getText())) return false;
      if (this.httpsCreateFns.has(callee.getText())) this.usesHttps = true;
      return true;
    }
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'createServer') {
      const target = unwrap(callee.getExpression());
      if (target === undefined) return false;
      if (Node.isIdentifier(target)) {
        if (!this.httpModules.has(target.getText())) return false;
        if (this.httpsModules.has(target.getText())) this.usesHttps = true;
        return true;
      }
      const spec = this.requireSpecifier(target);
      if (spec === undefined || !HTTP_MODULES.has(spec)) return false;
      if (spec === 'https' || spec === 'node:https') this.usesHttps = true;
      return true;
    }
    return false;
  }

  /** `express()` where `express` is the function of the `express` package. */
  private isExpressApp(call: Node): boolean {
    if (!Node.isCallExpression(call)) return false;
    const callee = unwrap(call.getExpression());
    if (callee === undefined) return false;
    if (Node.isIdentifier(callee)) return this.expressFns.has(callee.getText());
    return this.requireSpecifier(callee) === 'express';
  }

  /** What an expression is: an http or https server, an Express app, or unknown. Names follow their assignments in this file. */
  private trace(
    expr: Node | undefined,
    seen: Set<string> = new Set(),
    depth = 0,
  ): Trace | undefined {
    const node = unwrap(expr);
    if (node === undefined || depth > MAX_TRACE_DEPTH) return undefined;
    if (Node.isCallExpression(node)) {
      if (this.isHttpCreateServer(node)) return 'server';
      if (this.isExpressApp(node)) return 'app';
      const callee = node.getExpression();
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'listen') {
        // `app.listen(...)` and `server.listen(...)` both give the http server.
        return this.trace(callee.getExpression(), seen, depth + 1) === undefined
          ? undefined
          : 'server';
      }
      return undefined;
    }
    if (Node.isIdentifier(node) || this.isThisAccess(node)) {
      const key = node.getText();
      if (seen.has(key)) return undefined;
      const defs = this.defs.get(key);
      if (defs === undefined || defs.length === 0 || defs.length > MAX_DEFS_PER_NAME) {
        return undefined;
      }
      const top = seen.size === 0;
      if (top && this.traceMemo.has(key)) return this.traceMemo.get(key);
      const next = new Set(seen).add(key);
      let first: Trace | undefined;
      let known = true;
      for (const d of defs) {
        const t = this.trace(d, next, depth + 1);
        if (t === undefined) {
          known = false; // one assignment we cannot trace: not known
          break;
        }
        first ??= t;
      }
      const result = known ? first : undefined;
      if (top) this.traceMemo.set(key, result);
      return result;
    }
    return undefined;
  }

  // ------------------------------------------------------------ gaps

  /**
   * Whether the target of `Object.assign(target, source)` could be the server. It is not when
   * it is a literal, an Express app, or a local `const` initialised with an object literal and
   * declared once in this file. Anything else is: the server itself, a parameter, an imported
   * binding, a call result, a property access, a `let`, or a name that cannot be traced.
   */
  private assignTargetMayBeServer(arg: Node | undefined): boolean {
    const node = unwrap(arg);
    if (node === undefined) return false;
    if (Node.isObjectLiteralExpression(node) || Node.isArrayLiteralExpression(node)) return false;
    if (this.trace(node) === 'app') return false;
    if (Node.isIdentifier(node)) {
      const decls = this.sf.getVariableDeclarations().filter((d) => d.getName() === node.getText());
      const only = decls.length === 1 ? decls[0] : undefined;
      const list = only?.getParent();
      if (
        only !== undefined &&
        Node.isVariableDeclarationList(list) &&
        String(list.getDeclarationKind()) === 'const' &&
        Node.isObjectLiteralExpression(unwrap(only.getInitializer()) as Node)
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * References, not only calls (third review pass, N3a). Code can write a setting through an
   * alias that no call shape shows: `const R = Reflect`, `const e = eval`, `globalThis.Function`,
   * `Object['defineProperty']`, `(() => {}).constructor(...)`. So every reference in a read file
   * to these is a gap, whatever the receiver; a local variable or a parameter that merely shares
   * a name is a gap too (kept simple and conservative):
   *   - the global names `eval`, `Function`, `Reflect`;
   *   - the property names `defineProperty`, `defineProperties`, `setPrototypeOf`, as an
   *     identifier or a string key;
   *   - `Object.assign` used other than as a direct call, and `const X = Object`;
   *   - an import or require of `vm` or `node:vm`;
   *   - a property access named `constructor` on anything but `this`;
   *   - `setTimeout`, `setInterval` or `setImmediate` with a string or a concatenated string.
   */
  private reference(node: Node): void {
    if (Node.isIdentifier(node)) {
      const text = node.getText();
      if (REFERENCE_NAMES.has(text)) this.gaps.add('setting-form-not-read');
      return;
    }
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
      if (REFERENCE_KEYS.has(node.getLiteralValue())) this.gaps.add('setting-form-not-read');
      return;
    }
    if (Node.isPropertyAccessExpression(node)) {
      // `(() => {}).constructor` is the Function constructor: code from a string, under an alias.
      if (
        node.getName() === 'constructor' &&
        node.getExpression().getKind() !== ts.SyntaxKind.ThisKeyword
      ) {
        this.gaps.add('setting-form-not-read');
      }
      const parent = node.getParent();
      const direct = Node.isCallExpression(parent) && parent.getExpression() === node;
      if (node.getName() === 'assign' && node.getExpression().getText() === 'Object' && !direct) {
        this.gaps.add('setting-form-not-read');
      }
      return;
    }
    if (Node.isVariableDeclaration(node)) {
      const init = unwrap(node.getInitializer());
      if (init !== undefined && Node.isIdentifier(init) && init.getText() === 'Object') {
        this.gaps.add('setting-form-not-read');
      }
      return;
    }
    if (Node.isCallExpression(node)) {
      const callee = unwrap(node.getExpression());
      const timer =
        callee !== undefined && Node.isIdentifier(callee) && TIMERS.has(callee.getText());
      const first = unwrap(node.getArguments()[0]);
      if (
        timer &&
        first !== undefined &&
        (Node.isStringLiteral(first) ||
          Node.isNoSubstitutionTemplateLiteral(first) ||
          Node.isTemplateExpression(first) ||
          (Node.isBinaryExpression(first) &&
            first.getOperatorToken().getKind() === ts.SyntaxKind.PlusToken))
      ) {
        this.gaps.add('setting-form-not-read');
      }
    }
  }

  private isNonLocalCallee(callee: Node): boolean {
    let node: Node | undefined = unwrap(callee);
    while (node !== undefined && Node.isPropertyAccessExpression(node)) {
      node = unwrap(node.getExpression());
    }
    if (node === undefined || !Node.isIdentifier(node)) return false;
    const spec = this.importedFrom.get(node.getText());
    return spec !== undefined && !isLocalSpecifier(spec) && !isBuiltinSpecifier(spec);
  }

  private isServerTrace(node: Node | undefined): boolean {
    return this.trace(node) === 'server';
  }

  /** The argument is the server, or an object or array holding it. */
  private holdsServer(arg: Node): boolean {
    const node = unwrap(arg);
    if (node === undefined) return false;
    if (Node.isObjectLiteralExpression(node)) {
      return node.getProperties().some((p) => {
        if (Node.isShorthandPropertyAssignment(p)) return this.isServerTrace(p.getNameNode());
        if (Node.isPropertyAssignment(p)) return this.isServerTrace(p.getInitializer());
        if (Node.isSpreadAssignment(p)) return this.isServerTrace(p.getExpression());
        return false;
      });
    }
    if (Node.isArrayLiteralExpression(node)) {
      return node.getElements().some((e) => this.isServerTrace(e));
    }
    return this.isServerTrace(node);
  }

  private isTerminusCall(call: Node): boolean {
    if (!Node.isCallExpression(call)) return false;
    const callee = call.getExpression();
    if (Node.isIdentifier(callee)) return this.terminusFns.has(callee.getText());
    return (
      Node.isPropertyAccessExpression(callee) &&
      callee.getName() === 'createTerminus' &&
      Node.isIdentifier(callee.getExpression()) &&
      this.terminusModules.has(callee.getExpression().getText())
    );
  }

  private serverPassedOut(call: Node): void {
    if (!Node.isCallExpression(call) && !Node.isNewExpression(call)) return;
    if (!this.isNonLocalCallee(call.getExpression())) return;
    for (const arg of call.getArguments()) {
      if (this.holdsServer(arg)) {
        this.gaps.add('server-passed-out');
        // `createTerminus(server, ...)` is read as a drain, so it does not make the DRAIN search incomplete
        if (!this.isTerminusCall(call)) this.drainGaps.add('server-passed-out');
        return;
      }
    }
  }

  private push(found: Found, origin: Origin): void {
    this.found.push(found);
    this.origins.set(found, origin);
  }

  private addResolved(name: NodeSettingName, valueNode: Node, at: Node, origin: Origin): void {
    const source = this.src(at);
    const n = evalLiteral(valueNode);
    if (n === undefined) {
      this.push(
        {
          name,
          value: this.log.mark(
            'non-literal',
            source,
            `${name} is ${LABEL_NON_LITERAL}`,
            DECLARE_HINT,
          ),
          source,
        },
        origin,
      );
    } else if (n < 0) {
      this.push(
        {
          name,
          value: this.log.mark('unsupported-form', source, `${name} is ${LABEL_NEGATIVE_OR_ODD}`),
          source,
        },
        origin,
      );
    } else {
      this.push(
        {
          name,
          value: makeSourcedValue({ value: n, unit: 'ms', source, basis: 'declared' }),
          source,
        },
        origin,
      );
    }
  }

  private addUnresolved(
    name: NodeSettingName,
    at: Node,
    what: 'non-literal' | 'unsupported-form',
    origin: Origin,
  ): void {
    const source = this.src(at);
    const label = what === 'non-literal' ? LABEL_NON_LITERAL : LABEL_UNSUPPORTED_FORM;
    this.push(
      {
        name,
        value: this.log.mark(
          what,
          source,
          `${name} is ${label}`,
          what === 'non-literal' ? DECLARE_HINT : undefined,
        ),
        source,
      },
      origin,
    );
  }

  /** `x.name = v` and `x['name'] = v`; other operators on such a target are unsupported. */
  private assignment(node: Node): void {
    if (!Node.isBinaryExpression(node)) return;
    const op = node.getOperatorToken().getKind();
    const isAssign = op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
    if (!isAssign) return;
    const target = node.getLeft();
    let name: string | undefined;
    if (Node.isPropertyAccessExpression(target)) name = target.getName();
    else if (Node.isElementAccessExpression(target)) {
      const arg = target.getArgumentExpression();
      if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
        name = arg.getLiteralValue();
      } else if (
        !(arg && Node.isNumericLiteral(arg)) &&
        this.trace(target.getExpression()) === 'server'
      ) {
        // `server[k] = v` with a key computed at run time can write any setting. A receiver that
        // cannot be traced is not flagged: that would flag every array and map write.
        this.gaps.add('setting-form-not-read');
      }
    }
    if (name === undefined || !isSetting(name)) return;
    const origin: Origin = {
      kind: 'assign',
      at: node,
      receiver:
        Node.isPropertyAccessExpression(target) || Node.isElementAccessExpression(target)
          ? target.getExpression()
          : undefined,
    };
    if (op === ts.SyntaxKind.EqualsToken) this.addResolved(name, node.getRight(), node, origin);
    else this.addUnresolved(name, node, 'unsupported-form', origin);
  }

  /** The settings in an object literal; true when the literal is fully known (no spread, computed key or method). */
  private optionsObject(obj: Node, origin: Origin): void {
    if (!Node.isObjectLiteralExpression(obj)) return;
    const seen = new Set<NodeSettingName>();
    let opaque = false;
    for (const prop of obj.getProperties()) {
      if (
        Node.isPropertyAssignment(prop) ||
        Node.isShorthandPropertyAssignment(prop) ||
        Node.isMethodDeclaration(prop)
      ) {
        const nameNode = prop.getNameNode();
        let name: string | undefined;
        if (
          Node.isIdentifier(nameNode) ||
          Node.isStringLiteral(nameNode) ||
          Node.isNoSubstitutionTemplateLiteral(nameNode)
        ) {
          name = Node.isIdentifier(nameNode) ? nameNode.getText() : nameNode.getLiteralValue();
        } else if (Node.isNumericLiteral(nameNode)) name = undefined;
        else opaque = true; // computed key
        if (name === undefined || !isSetting(name)) continue;
        seen.add(name);
        if (Node.isPropertyAssignment(prop)) {
          const init = prop.getInitializer();
          if (init) this.addResolved(name, init, prop, origin);
        } else if (Node.isShorthandPropertyAssignment(prop)) {
          this.addUnresolved(name, prop, 'non-literal', origin); // `{ keepAliveTimeout }` is a variable
        } else this.addUnresolved(name, prop, 'unsupported-form', origin);
      } else {
        opaque = true; // spread, accessors
      }
    }
    if (opaque) {
      for (const name of NODE_SETTING_NAMES) {
        if (!seen.has(name)) this.addUnresolved(name, obj, 'unsupported-form', origin);
      }
    }
  }

  // ------------------------------------------------------------ the createServer arguments

  /** Every identifier of this file by its text, built once. */
  idents(name: string): Node[] {
    if (this.identIndex === undefined) {
      const index = new Map<string, Node[]>();
      this.sf.forEachDescendant((n) => {
        if (!Node.isIdentifier(n)) return;
        const list = index.get(n.getText());
        if (list === undefined) index.set(n.getText(), [n]);
        else list.push(n);
      });
      this.identIndex = index;
    }
    return this.identIndex.get(name) ?? [];
  }

  /**
   * True when any occurrence of this name in the file is written to: the left side of an
   * assignment (`=`, `||=`, `+=` and the rest), inside a destructuring assignment target, the
   * operand of `++`/`--`, or the variable of a `for...in`/`for...of` that is not a declaration.
   * Conservative: a write to a shadowing name in another scope counts too.
   */
  isWrittenTo(name: string): boolean {
    for (const id of this.idents(name)) {
      let child: Node = id;
      let parent = id.getParent();
      while (parent !== undefined) {
        if (
          Node.isBinaryExpression(parent) &&
          parent.getLeft() === child &&
          isAssignmentKind(parent.getOperatorToken().getKind())
        ) {
          return true;
        }
        if (
          (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) &&
          (parent.getOperatorToken() === ts.SyntaxKind.PlusPlusToken ||
            parent.getOperatorToken() === ts.SyntaxKind.MinusMinusToken)
        ) {
          return true;
        }
        if (
          (Node.isForInStatement(parent) || Node.isForOfStatement(parent)) &&
          parent.getInitializer() === child
        ) {
          return true;
        }
        // Climb only through destructuring patterns, so `[h] = ...` and `({h} = ...)` are found.
        if (
          Node.isArrayLiteralExpression(parent) ||
          Node.isObjectLiteralExpression(parent) ||
          Node.isShorthandPropertyAssignment(parent) ||
          Node.isPropertyAssignment(parent) ||
          Node.isSpreadElement(parent) ||
          Node.isParenthesizedExpression(parent)
        ) {
          child = parent;
          parent = parent.getParent();
          continue;
        }
        break;
      }
    }
    return false;
  }

  /** The variable and function declarations of this name, nested ones included. */
  declsNamed(name: string): { vars: Node[]; funcs: Node[] } {
    if (this.declIndex === undefined) {
      const vars: Node[] = [];
      const funcs: Node[] = [];
      this.sf.forEachDescendant((n) => {
        if (Node.isVariableDeclaration(n)) vars.push(n);
        else if (Node.isFunctionDeclaration(n)) funcs.push(n);
      });
      this.declIndex = { vars, funcs };
    }
    return {
      vars: this.declIndex.vars.filter(
        (d) => Node.isVariableDeclaration(d) && d.getName() === name,
      ),
      funcs: this.declIndex.funcs.filter(
        (d) => Node.isFunctionDeclaration(d) && d.getName() === name,
      ),
    };
  }

  /** `opts.x` read: not written, deleted, counted up or called. */
  private isPlainPropertyRead(id: Node): boolean {
    const access = id.getParent();
    if (!Node.isPropertyAccessExpression(access) || access.getExpression() !== id) return false;
    const up = access.getParent();
    if (Node.isBinaryExpression(up) && up.getLeft() === access) {
      const op = up.getOperatorToken().getKind();
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) return false;
    }
    if (Node.isPrefixUnaryExpression(up) || Node.isPostfixUnaryExpression(up)) return false;
    if (Node.isDeleteExpression(up)) return false;
    if (Node.isCallExpression(up) && up.getExpression() === access) return false;
    return true;
  }

  /** An object literal whose keys are all literal, with no spread, accessor or computed key. */
  private isLiteralOptions(obj: Node): boolean {
    if (!Node.isObjectLiteralExpression(obj)) return false;
    return obj.getProperties().every((p) => {
      if (
        !(
          Node.isPropertyAssignment(p) ||
          Node.isShorthandPropertyAssignment(p) ||
          Node.isMethodDeclaration(p)
        )
      ) {
        return false;
      }
      const key = p.getNameNode();
      return (
        Node.isIdentifier(key) ||
        Node.isStringLiteral(key) ||
        Node.isNoSubstitutionTemplateLiteral(key) ||
        Node.isNumericLiteral(key)
      );
    });
  }

  /**
   * An options argument that may stand: an object literal written in place, or an identifier
   * bound by `const` to one that is referenced nowhere else in the file except as this one
   * argument and plain property reads (and is not exported). A single reference closes every
   * alias, mutation and escape form at once, so none of them needs its own check.
   */
  private optionsArg(arg: Node): boolean {
    const node = unwrap(arg);
    if (node === undefined) return false;
    if (Node.isObjectLiteralExpression(node)) {
      if (!this.isLiteralOptions(node)) return false;
      this.optionsObject(node, { kind: 'options', create: this.activeCreate });
      return true;
    }
    if (!Node.isIdentifier(node)) return false;
    const { vars, funcs } = this.declsNamed(node.getText());
    const only = vars.length === 1 && funcs.length === 0 ? vars[0] : undefined;
    if (only === undefined || !Node.isVariableDeclaration(only)) return false;
    const list = only.getParent();
    const init = unwrap(only.getInitializer());
    if (
      !Node.isVariableDeclarationList(list) ||
      String(list.getDeclarationKind()) !== 'const' ||
      init === undefined ||
      !this.isLiteralOptions(init) ||
      only.getVariableStatement()?.hasExportKeyword() === true ||
      // Kept although the single-reference rule below also refuses `export { opts }` and `export default opts` (the
      // name is then used other than as a plain property read): the export is refused here by name, whatever the
      // later loop does.
      this.exportedNames().has(only.getName())
    ) {
      return false;
    }
    const nameNode = only.getNameNode();
    for (const id of this.idents(node.getText())) {
      if (id === nameNode || id.getStart() === node.getStart()) continue;
      if (!this.isPlainPropertyRead(id)) return false;
    }
    this.optionsObject(init, { kind: 'options', create: this.activeCreate });
    return true;
  }

  /**
   * A request handler that may stand: a function or arrow written in place, an identifier bound
   * to exactly one `const` arrow or function expression or one `function` declaration in this
   * file, or something traced to an `express()` call (here, or exported as one by a local file).
   */
  private handlerArg(arg: Node): boolean {
    const node = unwrap(arg);
    if (node === undefined) return false;
    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return true;
    if (Node.isIdentifier(node)) {
      const { vars, funcs } = this.declsNamed(node.getText());
      // A handler name must be bound once and never written to again (K1): `let h = fn;
      // h = {keepAliveTimeout: 1}; createServer(h)` would pass options, not a handler.
      if (vars.length + funcs.length === 1 && !this.isWrittenTo(node.getText())) {
        if (funcs.length === 1) return true;
        const only = vars[0];
        const list = only?.getParent();
        const init =
          only !== undefined && Node.isVariableDeclaration(only)
            ? unwrap(only.getInitializer())
            : undefined;
        if (
          Node.isVariableDeclarationList(list) &&
          String(list.getDeclarationKind()) === 'const' &&
          init !== undefined &&
          (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
        ) {
          return true;
        }
      }
      const local = this.importedLocal.get(node.getText());
      if (local !== undefined) {
        this.handlerImports.push({ ...local, line: this.lineOf(node) });
        return true; // settled once the file it names is read (`readNodeServer`)
      }
    }
    return this.trace(node) === 'app';
  }

  /**
   * `createServer([options][, handler])` is read only in an allowed form: no argument, one
   * argument that is an options object or a handler, or an options object and a handler.
   * Anything else (a call result, a spread, a member access, a conditional, `??`, an identifier
   * from elsewhere) could hold any setting, so the search is not complete.
   */
  private createServerArgs(call: Node): void {
    if (!Node.isCallExpression(call)) return;
    const args = call.getArguments();
    const [first, second] = args;
    if (first === undefined) return;
    this.activeCreate = call;
    const ok =
      args.length === 1
        ? this.optionsArg(first) || this.handlerArg(first)
        : args.length === 2 &&
          second !== undefined &&
          this.optionsArg(first) &&
          this.handlerArg(second);
    this.activeCreate = undefined;
    if (!ok) this.gaps.add('createserver-args');
  }

  /**
   * Names a top-level `export { name }` or `export default name` gives away, read from the syntax. (ts-morph's
   * `isExported()` asks the TypeScript binder, which is quadratic in the number of declarations of one name: a
   * 400 KB file of `var a = 1;` took 4 s and a 4.8 MB one never finished.)
   */
  private exportedNamesSet: Set<string> | undefined;
  private exportedNames(): ReadonlySet<string> {
    if (this.exportedNamesSet !== undefined) return this.exportedNamesSet;
    const names = new Set<string>();
    for (const statement of this.sf.getStatements()) {
      if (Node.isExportDeclaration(statement) && statement.getModuleSpecifier() === undefined) {
        for (const e of statement.getNamedExports()) names.add(e.getNameNode().getText());
      } else if (Node.isExportAssignment(statement)) {
        const expression = unwrap(statement.getExpression());
        if (expression !== undefined && Node.isIdentifier(expression))
          names.add(expression.getText());
      }
    }
    this.exportedNamesSet = names;
    return names;
  }

  /** What the file exports that is an Express app (see `exportedApps`). */
  private collectExports(): void {
    const isApp = (n: Node | undefined): boolean => this.trace(n) === 'app';
    this.sf.forEachDescendant((n) => {
      if (Node.isExportAssignment(n)) {
        if (isApp(n.getExpression())) {
          this.exportedApps.add(n.isExportEquals() ? 'module.exports' : 'default');
        }
      } else if (Node.isVariableStatement(n) && n.hasExportKeyword()) {
        for (const d of n.getDeclarations()) {
          if (isApp(d.getInitializer())) this.exportedApps.add(d.getName());
        }
      } else if (Node.isExportDeclaration(n) && n.getModuleSpecifier() === undefined) {
        for (const e of n.getNamedExports()) {
          if (isApp(e.getNameNode())) {
            this.exportedApps.add((e.getAliasNode() ?? e.getNameNode()).getText());
          }
        }
      } else if (
        Node.isBinaryExpression(n) &&
        n.getOperatorToken().getKind() === ts.SyntaxKind.EqualsToken &&
        isApp(n.getRight())
      ) {
        const left = n.getLeft().getText();
        if (left === 'module.exports') this.exportedApps.add('module.exports');
        else if (left.startsWith('module.exports.')) {
          this.exportedApps.add(left.slice('module.exports.'.length));
        } else if (left.startsWith('exports.'))
          this.exportedApps.add(left.slice('exports.'.length));
      }
    });
  }

  private call(node: Node): void {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    let name: string | undefined;
    if (Node.isIdentifier(callee)) name = callee.getText();
    else if (Node.isPropertyAccessExpression(callee)) name = callee.getName();
    if (this.isHttpCreateServer(node)) {
      this.site ??= this.src(node);
      this.createServerArgs(node);
    } else if (name === 'listen' && Node.isPropertyAccessExpression(callee)) {
      // A site only on an http or https server or an Express app; anything else is
      // a framework tripcurve does not read, and its defaults are not guessed.
      if (this.trace(callee.getExpression()) === undefined) this.gaps.add('framework-not-read');
      else this.site ??= this.src(node);
      this.listenCalls.push(node);
    } else if (
      name === 'assign' &&
      Node.isPropertyAccessExpression(callee) &&
      callee.getExpression().getText() === 'Object'
    ) {
      const [target, ...sources] = node.getArguments();
      const receiver = unwrap(target);
      for (const arg of sources) this.optionsObject(arg, { kind: 'assign', at: node, receiver });
      // A source that is not an object literal can hold any setting.
      if (
        sources.some((a) => !Node.isObjectLiteralExpression(a)) &&
        this.assignTargetMayBeServer(target)
      ) {
        this.gaps.add('setting-form-not-read');
      }
    } else if (name === 'require' && Node.isIdentifier(callee)) {
      this.moduleSpecifier(node.getArguments()[0], node);
    } else if (callee.getKind() === ts.SyntaxKind.ImportKeyword) {
      this.moduleSpecifier(node.getArguments()[0], node);
    }
    this.serverPassedOut(node);
  }

  private moduleSpecifier(arg: Node | undefined, at: Node): void {
    if (!arg || !(Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
      // `require(name)` or `import(name)`: it can load any file, so the search is not complete.
      this.dynamicLoads.push(this.lineOf(at));
      return;
    }
    const spec = arg.getLiteralValue();
    if (VM_MODULES.has(spec)) this.gaps.add('setting-form-not-read'); // runs code from a string
    if (isLocalSpecifier(spec)) {
      this.imports.push({ specifier: inputText(spec), line: this.lineOf(at) });
    } else if (!isBuiltinSpecifier(spec)) {
      if (isShutdownLibrary(spec)) this.drainGaps.add('shutdown-library');
      if (this.isSideEffectLoad(at)) this.drainGaps.add('side-effect-import');
      // "No drain" is an absence claim: any package runs its module code, which could register a signal
      // handler. Only built-ins, local files and type-only imports leave the search complete; terminus
      // and lightship are read forms (B4 second review, N1).
      const typeOnly =
        (Node.isImportDeclaration(at) || Node.isExportDeclaration(at)) && at.isTypeOnly();
      if (!typeOnly && !READ_PACKAGES.has(packageNameOf(spec)))
        this.drainGaps.add('package-imported');
    }
  }

  /** `import 'pkg';`, or `require('pkg');` / `import('pkg');` as a whole statement: loaded only for what it does. */
  private isSideEffectLoad(at: Node): boolean {
    if (Node.isImportDeclaration(at)) return at.getImportClause() === undefined;
    let outer: Node = at;
    let parent = outer.getParent();
    while (
      parent !== undefined &&
      (Node.isAwaitExpression(parent) || Node.isParenthesizedExpression(parent))
    ) {
      outer = parent;
      parent = parent.getParent();
    }
    return parent !== undefined && Node.isExpressionStatement(parent);
  }

  visit(node: Node): void {
    this.reference(node);
    if (Node.isBinaryExpression(node)) this.assignment(node);
    else if (Node.isCallExpression(node)) this.call(node);
    else if (Node.isNewExpression(node)) {
      this.serverPassedOut(node);
    } else if (Node.isImportDeclaration(node)) {
      this.moduleSpecifier(node.getModuleSpecifier(), node);
    } else if (Node.isExportDeclaration(node)) {
      // `export { x }` with no `from` names no module.
      const spec = node.getModuleSpecifier();
      if (spec) this.moduleSpecifier(spec, node);
    } else if (Node.isImportEqualsDeclaration(node)) {
      const ref = node.getModuleReference();
      if (Node.isExternalModuleReference(ref)) this.moduleSpecifier(ref.getExpression(), node);
    }
  }

  run(): void {
    // Two passes: bindings first (a use can come before its import in source order), then the walk.
    this.sf.forEachDescendant((node) => {
      this.collectBindings(node);
    });
    this.collectExports();
    this.sf.forEachDescendant((node) => {
      this.visit(node);
    });
  }

  // ------------------------------------------------------------ which server, and when

  /**
   * The listening server variable is used other than as the receiver of a property access (`server.on`,
   * `server.close`) or as the first argument of `createTerminus`: an alias, a pass to another function,
   * an object, an export, a return. Code that holds the server could handle the signal (N2).
   */
  private serverEscapes(serverKey: string | undefined): boolean {
    if (serverKey === undefined || !serverKey.startsWith('id:')) return false;
    for (const id of this.idents(serverKey.slice(3))) {
      const p = id.getParent();
      if (p === undefined) continue;
      if (Node.isPropertyAccessExpression(p) && p.getExpression() === id) continue;
      if (Node.isPropertyAccessExpression(p)) continue; // `x.server`: a name, not the variable
      if (Node.isVariableDeclaration(p) && p.getNameNode() === id) continue;
      if (
        Node.isBinaryExpression(p) &&
        p.getLeft() === id &&
        p.getOperatorToken().getKind() === ts.SyntaxKind.EqualsToken
      )
        continue;
      if (Node.isCallExpression(p) && p.getArguments()[0] === id && this.isTerminusCall(p))
        continue;
      return true;
    }
    return false;
  }

  /** True when a top-level `process.exit(...)` or `throw` comes before the top-level statement that holds the first `listen`. */
  private deadBeforeListen(): boolean {
    let firstListen = Number.POSITIVE_INFINITY;
    for (const call of this.listenCalls) {
      let top: Node | undefined = call;
      while (
        top !== undefined &&
        top.getParent() !== undefined &&
        !Node.isSourceFile(top.getParent() as Node)
      ) {
        top = top.getParent();
      }
      if (top !== undefined) firstListen = Math.min(firstListen, top.getStart());
    }
    if (!Number.isFinite(firstListen)) return false;
    for (const st of this.sf.getStatements()) {
      if (st.getStart() >= firstListen) break;
      if (Node.isThrowStatement(st)) return true;
      if (Node.isExpressionStatement(st)) {
        const e = unwrap(st.getExpression());
        if (e !== undefined && Node.isCallExpression(e)) {
          const callee = e.getExpression();
          if (
            Node.isPropertyAccessExpression(callee) &&
            callee.getName() === 'exit' &&
            Node.isIdentifier(callee.getExpression()) &&
            this.processNames.has(callee.getExpression().getText())
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /** The binding a node stands for: `id:<name>`, or `call:<offset>` for a `createServer` call; otherwise none. */
  keyOf(node: Node | undefined): string | undefined {
    const n = unwrap(node);
    if (n === undefined) return undefined;
    if (Node.isIdentifier(n)) return `id:${n.getText()}`;
    if (Node.isCallExpression(n) && this.isHttpCreateServer(n)) return `call:${n.getStart()}`;
    return undefined;
  }

  /** The binding a `createServer` call is stored in (`const s = ...`, `s = ...`) or `.listen`ed on directly. */
  private createBinding(create: Node): string | undefined {
    let outer: Node = create;
    let parent = outer.getParent();
    while (
      parent !== undefined &&
      (Node.isParenthesizedExpression(parent) ||
        Node.isAsExpression(parent) ||
        Node.isNonNullExpression(parent))
    ) {
      outer = parent;
      parent = parent.getParent();
    }
    if (parent === undefined) return undefined;
    if (Node.isVariableDeclaration(parent) && parent.getInitializer() === outer) {
      const name = parent.getNameNode();
      return Node.isIdentifier(name) ? `id:${name.getText()}` : undefined;
    }
    if (
      Node.isBinaryExpression(parent) &&
      parent.getOperatorToken().getKind() === ts.SyntaxKind.EqualsToken &&
      parent.getRight() === outer &&
      Node.isIdentifier(parent.getLeft())
    ) {
      return `id:${parent.getLeft().getText()}`;
    }
    if (
      Node.isPropertyAccessExpression(parent) &&
      parent.getExpression() === outer &&
      parent.getName() === 'listen'
    ) {
      return `call:${create.getStart()}`;
    }
    return undefined;
  }

  /** A name assigned exactly once in this file: the one binding the search can follow. */
  boundOnce(key: string): boolean {
    return !key.startsWith('id:') || this.defs.get(key.slice(3))?.length === 1;
  }

  /** `stmt` is the statement `node` is, as `x = node;`, `const x = node;` or `node;`, with nothing around it. */
  isDirectStatementOf(stmt: Node, node: Node): boolean {
    if (Node.isExpressionStatement(stmt)) {
      const e = unwrap(stmt.getExpression());
      if (e === node) return true;
      return (
        e !== undefined &&
        Node.isBinaryExpression(e) &&
        e.getOperatorToken().getKind() === ts.SyntaxKind.EqualsToken &&
        unwrap(e.getRight()) === node
      );
    }
    if (Node.isVariableStatement(stmt)) {
      return stmt.getDeclarations().some((d) => unwrap(d.getInitializer()) === node);
    }
    return false;
  }

  private readonly invokedMemo = new Map<Node, boolean>();

  /**
   * The function runs from a statement at the top of the file: it is called by name as a whole
   * statement (`main();`, `await main();`, `main().catch(...)`), or it is called where it is
   * written (an IIFE). A function that is never called, or only under a condition, is not shown to run.
   */
  private invokedAtTop(fn: Node): boolean {
    const memo = this.invokedMemo.get(fn);
    if (memo !== undefined) return memo;
    let name: string | undefined;
    let result = false;
    if (Node.isFunctionDeclaration(fn)) {
      name = fn.getName();
    } else {
      let outer: Node = fn;
      let parent = outer.getParent();
      while (parent !== undefined && Node.isParenthesizedExpression(parent)) {
        outer = parent;
        parent = parent.getParent();
      }
      if (
        parent !== undefined &&
        Node.isCallExpression(parent) &&
        parent.getExpression() === outer
      ) {
        const st = statementOf(parent);
        result = st !== undefined && Node.isExpressionStatement(st) && st.getParent() === this.sf;
      } else if (
        parent !== undefined &&
        Node.isVariableDeclaration(parent) &&
        unwrap(parent.getInitializer()) === fn &&
        Node.isIdentifier(parent.getNameNode())
      ) {
        name = parent.getNameNode().getText();
      }
    }
    if (name !== undefined) {
      for (const st of this.sf.getStatements()) {
        if (Node.isExpressionStatement(st) && rootCallee(st.getExpression()) === name) {
          result = true;
          break;
        }
      }
    }
    this.invokedMemo.set(fn, result);
    return result;
  }

  /** The statements of `parent` run in sequence from the top: the file, or the body of a function that is called there. */
  plainSequence(parent: Node): boolean {
    if (Node.isSourceFile(parent)) return true;
    if (!Node.isBlock(parent)) return false;
    const fn = parent.getParent();
    return (
      fn !== undefined &&
      (Node.isFunctionDeclaration(fn) ||
        Node.isFunctionExpression(fn) ||
        Node.isArrowFunction(fn)) &&
      this.invokedAtTop(fn)
    );
  }

  /**
   * Which settings cannot be used, once the file is read. Only a value that is
   * bound to the server that listens AND written on an unconditional path before `listen` was
   * measured. `unattributed`: written on an object the search cannot tie to the one listening
   * server (another server, an alias, an unrelated object, or any file with no single `listen`).
   * `notBeforeListen`: tied to the server, but not shown to run before listen as a plain statement
   * (after listen, under a condition or a loop, in a callback or a function that is not called
   * from the top of the file). The work is linear: each listen call is read once, and each setting
   * is compared with the first listen statement of the common sequence.
   */
  finalize(): {
    notBeforeListen: NodeSettingName[];
    unattributed: NodeSettingName[];
    listenServers: number;
    assignedNames: NodeSettingName[];
    optionNames: NodeSettingName[];
    drains: NodeDrain[];
  } {
    const keys = new Set<string>();
    let ambiguous = false;
    let allDirect = true;
    let parent: Node | undefined;
    let sameParent = true;
    let firstListen = Number.POSITIVE_INFINITY;
    for (const call of this.listenCalls) {
      const callee = Node.isCallExpression(call) ? call.getExpression() : undefined;
      const receiver =
        callee !== undefined && Node.isPropertyAccessExpression(callee)
          ? callee.getExpression()
          : undefined;
      const key = this.keyOf(receiver);
      if (key === undefined || this.trace(receiver) !== 'server' || !this.boundOnce(key)) {
        ambiguous = true;
      } else keys.add(key);
      const st = statementOf(call);
      if (st === undefined || !this.isDirectStatementOf(st, call)) {
        allDirect = false;
        continue;
      }
      const par = st.getParent();
      if (parent === undefined) parent = par;
      else if (parent !== par) sameParent = false;
      firstListen = Math.min(firstListen, st.getStart());
    }
    const listenServers = this.listenCalls.length === 0 ? 0 : ambiguous ? 2 : keys.size;
    const serverKey = listenServers === 1 ? [...keys][0] : undefined;
    // A top-level `process.exit(...)` or `throw` before the first `listen` makes what follows a dead path:
    // nothing after it is shown to run (B4 review, minor 5).
    const dead = this.deadBeforeListen();
    if (this.serverEscapes(serverKey)) this.drainGaps.add('server-passed-out');
    const ordered =
      !dead && allDirect && sameParent && parent !== undefined && this.plainSequence(parent);

    const notBefore = new Set<NodeSettingName>();
    const unattributed = new Set<NodeSettingName>();
    const assigned = new Set<NodeSettingName>();
    const viaOptions = new Set<NodeSettingName>();
    for (const [found, origin] of this.origins) {
      (origin.kind === 'assign' ? assigned : viaOptions).add(found.name);
      let key: string | undefined;
      let at: Node | undefined;
      if (origin.kind === 'assign') {
        key = this.keyOf(origin.receiver);
        at = origin.at;
      } else if (origin.create !== undefined) {
        key = this.createBinding(origin.create);
        at = origin.create;
      }
      const attributed =
        serverKey !== undefined && key === serverKey && this.boundOnce(key) && at !== undefined;
      if (!attributed || at === undefined || key === undefined) {
        unattributed.add(found.name);
        continue;
      }
      // `createServer(...).listen(...)` in one statement: the options come first by construction.
      if (origin.kind === 'options' && key.startsWith('call:')) continue;
      const st = statementOf(at);
      const before =
        ordered &&
        st !== undefined &&
        this.isDirectStatementOf(st, at) &&
        st.getParent() === parent &&
        st.getStart() < firstListen;
      if (!before) notBefore.add(found.name);
    }
    return {
      notBeforeListen: NODE_SETTING_NAMES.filter((n) => notBefore.has(n)),
      unattributed: NODE_SETTING_NAMES.filter((n) => unattributed.has(n)),
      listenServers,
      assignedNames: NODE_SETTING_NAMES.filter((n) => assigned.has(n)),
      optionNames: NODE_SETTING_NAMES.filter((n) => viaOptions.has(n)),
      drains: new DrainReader(this, {
        lightshipFns: this.lightshipFns,
        lightshipModules: this.lightshipModules,
        terminusFns: this.terminusFns,
        terminusModules: this.terminusModules,
        processNames: this.processNames,
        timerFns: this.timerFns,
        timerModules: this.timerModules,
      }).read(serverKey, dead),
    };
  }
}

/** The name a whole-statement call is made through: `main()`, `await main()`, `main().catch(...)`. */
function rootCallee(expression: Node | undefined): string | undefined {
  let current = unwrap(expression);
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (!Node.isCallExpression(current)) return undefined;
    const callee = current.getExpression();
    if (Node.isIdentifier(callee)) return callee.getText();
    if (
      Node.isPropertyAccessExpression(callee) &&
      ['catch', 'then', 'finally'].includes(callee.getName())
    ) {
      current = unwrap(callee.getExpression());
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** The offset of the first syntax error of a parsed file, or undefined when it parsed cleanly. */
function firstSyntaxError(sf: SourceFile): number | undefined {
  const diags = (sf.compilerNode as unknown as { parseDiagnostics?: readonly { start?: number }[] })
    .parseDiagnostics;
  if (!Array.isArray(diags) || diags.length === 0) return undefined;
  return diags[0]?.start ?? 0;
}

/** The 1-based line of an offset (a line break is `\n`, as everywhere else in tripcurve). */
function lineAt(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = text.indexOf('\n'); i !== -1 && i < end; i = text.indexOf('\n', i + 1)) line += 1;
  return line;
}

/**
 * The most syntax nodes of one source file tripcurve reads. A bound on the input, never a clock: the work and the
 * memory of the walk grow with the number of nodes, and the limit is a number so the output cannot depend on the
 * machine. Derived from measurements (Node 22.23.2, macOS arm64, 2026-11-14; docs/limits.md): the walk costs about
 * 3 to 4 microseconds and 0.4 to 0.5 kB per node, so 500 000 nodes read in about 1.5 s with a peak resident size
 * of about 0.5 GB, while 2.4 million nodes (a 4.8 MB file) took 7 to 8 s and 1.0 to 1.4 GB. Ordinary code has about
 * one node per 3.4 bytes (a limit of about 1.7 MB); the densest text has one per 2 bytes (about 1 MB). A file over the
 * limit is listed under "Files not checked" as `source-too-large` and nothing is read from it.
 */
export const MAX_SOURCE_NODES = 500_000;

/** True when the tree has more than `limit` nodes. Iterative, so a deep tree cannot overflow the stack, and it stops at the limit. */
function overNodeLimit(root: ts.Node, limit: number): boolean {
  let count = 0;
  const stack: ts.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ts.Node;
    count += 1;
    if (count > limit) return true;
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
  }
  return false;
}

function unchecked(
  file: InputText,
  reasonCode: 'source-parse-error' | 'source-too-large' | 'over-depth',
  line?: number,
): NodeFileReading {
  return {
    file,
    settings: [],
    notBeforeListen: [],
    unattributed: [],
    listenServers: 0,
    assignedNames: [],
    optionNames: [],
    usesHttps: false,
    imports: [],
    gaps: [],
    drainGaps: [],
    drains: [],
    handlerImports: [],
    exportedApps: [],
    unchecked: line === undefined ? { path: file, reasonCode } : { path: file, reasonCode, line },
  };
}

/**
 * Reads one source file. Never throws: a file that cannot be parsed is
 * returned as unchecked (`parse-error`, `over-depth`) with nothing read from it.
 */
export function readNodeSourceFile(file: InputFile, log?: UnresolvedLog): NodeFileReading {
  const text = rawTextForParser(file);
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noLib: true, noResolve: true },
  });
  try {
    let sf = project.createSourceFile('/source.tsx', text, {
      overwrite: true,
      scriptKind: ScriptKind.TSX,
    });
    if (firstSyntaxError(sf) !== undefined) {
      sf = project.createSourceFile('/source.ts', text, {
        overwrite: true,
        scriptKind: ScriptKind.TS,
      });
      const at = firstSyntaxError(sf);
      if (at !== undefined)
        return unchecked(file.canonicalPath, 'source-parse-error', lineAt(text, at));
    }
    // The walk below wraps every node, and that cost is the one thing left that grows with the file: bound it.
    if (overNodeLimit(sf.compilerNode, MAX_SOURCE_NODES)) {
      return unchecked(file.canonicalPath, 'source-too-large');
    }
    const walk = new FileWalk(file.canonicalPath, sf);
    walk.run();
    if (log) log.items.push(...walk.log.items);
    return {
      file: file.canonicalPath,
      settings: walk.found,
      ...walk.finalize(),
      usesHttps: walk.usesHttps,
      ...(walk.site === undefined ? {} : { constructionSite: walk.site }),
      imports: walk.imports,
      gaps: [...walk.gaps, ...(walk.dynamicLoads.length > 0 ? (['dynamic-load'] as const) : [])],
      drainGaps: [...walk.drainGaps],
      handlerImports: walk.handlerImports,
      exportedApps: [...walk.exportedApps],
    };
  } catch (error) {
    return unchecked(
      file.canonicalPath,
      error instanceof RangeError ? 'over-depth' : 'source-parse-error',
    );
  }
}

// ---------------------------------------------------------------- the walk over imports

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** `a/b/../c` to `a/c`; undefined when it climbs out of the root. */
function normalise(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.pop() === undefined) return undefined;
    } else out.push(part);
  }
  return out.join('/');
}

function stripJsExtension(spec: string): string | undefined {
  for (const [from, to] of [
    ['.js', '.ts'],
    ['.jsx', '.tsx'],
    ['.mjs', '.mts'],
    ['.cjs', '.cts'],
  ] as const) {
    if (spec.endsWith(from)) return spec.slice(0, -from.length) + to;
  }
  return undefined;
}

function candidates(base: string, spec: string): string[] {
  const full = normalise(`${base}/${spec}`);
  if (full === undefined) return [];
  const out: string[] = [full];
  const swapped = stripJsExtension(full);
  if (swapped !== undefined) out.push(swapped);
  for (const ext of SOURCE_EXTENSIONS) out.push(`${full}${ext}`);
  for (const ext of SOURCE_EXTENSIONS) out.push(`${full}/index${ext}`);
  return out;
}

const MERGE_REASON_AMBIGUOUS = 'ambiguous' as const;

function mergeSetting(
  name: NodeSettingName,
  all: readonly Found[],
  log: UnresolvedLog,
): NodeSettingValue | undefined {
  const items = all.filter((f) => f.name === name);
  const first = items[0];
  if (first === undefined) return undefined;
  if (items.length === 1) return first.value;
  const resolved = items.filter((i) => !('unresolved' in i.value));
  if (resolved.length === items.length) {
    const values = new Set(items.map((i) => (i.value as { value: unknown }).value));
    if (values.size === 1) return first.value;
  }
  // Mixed or different: the program may set it either way; never choose.
  const unresolvedOnes = items.filter((i) => 'unresolved' in i.value);
  if (unresolvedOnes.length === items.length) return first.value;
  const value: UnresolvedValue = log.mark(
    MERGE_REASON_AMBIGUOUS,
    first.source,
    `${name} is ${LABEL_AMBIGUOUS}`,
    DECLARE_HINT,
  );
  return value;
}

export interface NodeReadOptions {
  /**
   * Code Node runs before the entry file (preload flags, `NODE_OPTIONS`): local files
   * are read like imports of the entry file, the gaps make the search incomplete.
   */
  readonly preloads?: NodePreloads;
  /**
   * How many levels of local imports to follow from the entry file. Default:
   * no number (each file is read once, so the work is bounded by the input;
   * docs/limits.md). Tests pass a small value.
   */
  readonly maxImportDepth?: number;
}

/**
 * Reads the entry file and the local files it imports. `entry` must be one of
 * `intakeResult.files`. Pure: the result is a function of the intake result.
 */
export function readNodeServer(
  intakeResult: IntakeResult,
  entry: InputFile,
  options: NodeReadOptions = {},
): NodeServerSettings {
  const maxDepth = options.maxImportDepth ?? Number.POSITIVE_INFINITY;
  const log = new UnresolvedLog();
  const byPath = new Map<string, InputFile>();
  for (const f of intakeResult.files) {
    if (f.class === 'node-source') byPath.set(rawInputTextForParser(f.canonicalPath), f);
  }

  const filesRead: InputText[] = [];
  const imports: InputText[] = [];
  const uncheckedFiles: UncheckedInput[] = [];
  const unreadImports: InputText[] = [];
  // The raw texts of `unreadImports`, so a specifier is added once without scanning the list (a file of thousands of
  // imports of missing files was quadratic).
  const unreadSeen = new Set<string>();
  const settings: Found[] = [];
  const notBeforeListen = new Set<NodeSettingName>();
  const unattributed = new Set<NodeSettingName>();
  const assignedNames = new Set<NodeSettingName>();
  const optionNames = new Set<NodeSettingName>();
  let listenServers = 0;
  let usesHttps = false;
  const drains: NodeDrain[] = [];
  const drainGaps = new Set<NodeDrainGap>();
  const gaps = new Set<NodeSearchGap>(options.preloads?.gaps ?? []);
  let site: SourceRef | undefined;

  const readings = new Map<string, NodeFileReading>();
  const visited = new Set<string>();
  const queue: { file: InputFile; depth: number }[] = [{ file: entry, depth: 0 }];
  visited.add(rawInputTextForParser(entry.canonicalPath));
  // Preloaded files are read like imports of the entry file, so their own imports are followed.
  for (const preload of options.preloads?.files ?? []) {
    const base = rawInputTextForParser(preload.base);
    let target: InputFile | undefined;
    for (const c of candidates(base, rawInputTextForParser(preload.specifier))) {
      target = byPath.get(c);
      if (target) break;
    }
    if (target === undefined) {
      // A preload that names no file in the input is code that runs and was not read.
      gaps.add('preload-not-read');
      unreadImports.push(preload.specifier);
      unreadSeen.add(rawInputTextForParser(preload.specifier));
      continue;
    }
    const key = rawInputTextForParser(target.canonicalPath);
    if (visited.has(key)) continue;
    visited.add(key);
    queue.push({ file: target, depth: 1 });
  }
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const reading = readNodeSourceFile(item.file, log);
    if (reading.unchecked) {
      uncheckedFiles.push(reading.unchecked);
      continue;
    }
    readings.set(rawInputTextForParser(item.file.canonicalPath), reading);
    filesRead.push(item.file.canonicalPath);
    if (item.file !== entry) imports.push(item.file.canonicalPath);
    site ??= reading.constructionSite;
    for (const g of reading.gaps) gaps.add(g);
    if (reading.gaps.includes('dynamic-load')) {
      unreadImports.push(inputText('<computed module name>'));
      unreadSeen.add('<computed module name>');
    }
    for (const s of reading.settings) settings.push(s);
    for (const n of reading.notBeforeListen) notBeforeListen.add(n);
    for (const n of reading.unattributed) unattributed.add(n);
    for (const n of reading.assignedNames) assignedNames.add(n);
    for (const n of reading.optionNames) optionNames.add(n);
    listenServers += reading.listenServers;
    for (const d of reading.drains) drains.push(d);
    for (const g of reading.drainGaps) drainGaps.add(g);
    usesHttps ||= reading.usesHttps;
    if (item.depth >= maxDepth) {
      for (const i of reading.imports) {
        unreadImports.push(i.specifier);
        unreadSeen.add(rawInputTextForParser(i.specifier));
      }
      continue;
    }
    const base = dirOf(rawInputTextForParser(item.file.canonicalPath));
    for (const imp of reading.imports) {
      const spec = rawInputTextForParser(imp.specifier);
      if (NON_SOURCE_EXTENSIONS.some((e) => spec.endsWith(e))) continue;
      let target: InputFile | undefined;
      for (const c of candidates(base, spec)) {
        target = byPath.get(c);
        if (target) break;
      }
      if (target === undefined) {
        if (!unreadSeen.has(spec)) {
          unreadSeen.add(spec);
          unreadImports.push(imp.specifier);
        }
        continue;
      }
      const key = rawInputTextForParser(target.canonicalPath);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ file: target, depth: item.depth + 1 });
    }
  }

  // A handler imported from a local file stands only if that file exports an Express app.
  for (const reading of readings.values()) {
    const base = dirOf(rawInputTextForParser(reading.file));
    for (const imp of reading.handlerImports) {
      let target: InputFile | undefined;
      for (const c of candidates(base, imp.specifier)) {
        target = byPath.get(c);
        if (target) break;
      }
      const exported =
        target && readings.get(rawInputTextForParser(target.canonicalPath))?.exportedApps;
      const ok =
        exported !== undefined &&
        (imp.member === 'default'
          ? exported.includes('default') || exported.includes('module.exports')
          : exported.includes(imp.member));
      if (!ok) gaps.add('createserver-args');
    }
  }

  // A drain tied to "the listening server" of its file says nothing when more than one server listens.
  const tiedDrains: NodeDrain[] = drains.map((d) =>
    listenServers > 1 && d.kind !== 'lightship' && d.delay.state === 'literal'
      ? {
          kind: d.kind,
          source: d.source,
          delay: {
            state: 'unresolved' as const,
            value: log.mark(
              'drain-unresolved-duration',
              d.source,
              'more than one server listens in the files read, so a drain cannot be tied to the one that serves',
              DRAIN_HINT,
            ),
          },
        }
      : d,
  );
  const result: Partial<Record<NodeSettingName, NodeSettingValue>> = {};
  const mergeLog = new UnresolvedLog();
  for (const name of NODE_SETTING_NAMES) {
    const v = mergeSetting(name, settings, mergeLog);
    if (v !== undefined) result[name] = v;
  }

  // The per-file log already holds the non-literal items; the merge adds ambiguity.
  const unresolved: ReaderUnresolved[] = [...log.items, ...mergeLog.items];
  const searchComplete =
    site !== undefined &&
    uncheckedFiles.length === 0 &&
    unreadImports.length === 0 &&
    gaps.size === 0;
  return {
    entryFile: entry.canonicalPath,
    ...result,
    notBeforeListen: NODE_SETTING_NAMES.filter((n) => notBeforeListen.has(n)),
    // More than one listening server across the files read: no setting can be tied to the one that serves.
    unattributed: NODE_SETTING_NAMES.filter(
      (n) => unattributed.has(n) || (listenServers > 1 && settings.some((f) => f.name === n)),
    ),
    optionsOnly: NODE_SETTING_NAMES.filter((n) => optionNames.has(n) && !assignedNames.has(n)),
    usesHttps,
    ...(site === undefined ? {} : { constructionSite: site }),
    imports,
    filesRead,
    drains: tiedDrains,
    drainGaps: NODE_DRAIN_GAPS.filter((g) => drainGaps.has(g)),
    unchecked: uncheckedFiles,
    unreadImports,
    gaps: NODE_SEARCH_GAPS.filter((g) => gaps.has(g)),
    searchComplete,
    unresolved,
  };
}

/** `=`, `+=`, `||=` and every other assignment operator. */
function isAssignmentKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}
