// In-process drains of a Node server: a delay between SIGTERM and the server
// stopping that the source itself shows, read WITHOUT running anything. Three sources:
//   - `lightship`: `createLightship()` delays its shutdown handlers by `shutdownDelay` (default
//     5000 ms under Kubernetes: the knowledge base's measured entry, applied by the resolver);
//   - `@godaddy/terminus`: `createTerminus(server, { beforeShutdown })` runs `beforeShutdown` before
//     the server stops; it has no default delay, so only a literal delay inside it counts;
//   - a SIGTERM handler on the process that waits a literal time before it closes the server.
//
// The allow-list approach of B1 to B3. A drain counts only when ALL of these hold; every other case
// is a drain of UNRESOLVED duration (never a drain that is not there, never a delay guessed):
//   - the call or registration is a plain statement on a path that runs from the top of the file
//     (the file, or a function called there), not under a condition, loop or callback;
//   - it is tied to the PROCESS (lightship, a handler on the global `process`) or to the ONE
//     listening server of the file (terminus; the `close` of a handler);
//   - its options and its body are in the small set of forms below, and the delay is a number
//     written in the code.
// Forms of a delay: `await new Promise(r => setTimeout(r, N))` (also with `resolve => { ... }`) and
// `await sleep(N)` where `sleep` is `setTimeout` of `timers/promises`; N a literal (a product of
// literals). A handler is a list of statements: log calls, delays, then the statement that STOPS the
// server (`<server>.close(...)` or `process.exit(...)`), after which anything may follow; or a
// single `setTimeout(() => <stop>, N)` followed only by log calls. A timer that runs AFTER the stop
// (a kill timer) is not a drain, and a timer before a stop it does not contain is not read.
// "Not found" is never evidence here: whether the SEARCH was complete is the resolver's question.

import { Node } from 'ts-morph';
import { makeSourcedValue } from '../../core/index.js';
import { evalLiteral, statementOf, unwrap } from './ast-helpers.js';
import type { NodeDrain, NodeDrainDelay, NodeDrainKind } from './model.js';
import type { FileWalk } from './read-node-source.js';

/** The names a file binds to the modules whose use makes a drain (collected by the file walk). */
export interface DrainBindings {
  readonly lightshipFns: ReadonlySet<string>;
  readonly lightshipModules: ReadonlySet<string>;
  readonly terminusFns: ReadonlySet<string>;
  readonly terminusModules: ReadonlySet<string>;
  /** `process`, and any name bound to the `process` module. */
  readonly processNames: ReadonlySet<string>;
  /** Local names bound to `setTimeout` of `timers/promises`, and to the module itself. */
  readonly timerFns: ReadonlySet<string>;
  readonly timerModules: ReadonlySet<string>;
}

export const DRAIN_HINT = 'declare drain.in_process_s for this workload in tripcurve.yaml';

/** More registrations than this in one file is not read (hostile input): one unresolved drain. */
const MAX_SITES = 200;

const SIGNAL_METHODS: ReadonlySet<string> = new Set([
  'on',
  'once',
  'addListener',
  'prependListener',
  'prependOnceListener',
]);
const LOG_NAMES: ReadonlySet<string> = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']);
/** What `process.<member>` may be without the file doing something tripcurve does not read with the process. */
const PROCESS_MEMBERS: ReadonlySet<string> = new Set([
  'env',
  'argv',
  'argv0',
  'execArgv',
  'execPath',
  'exit',
  'exitCode',
  'pid',
  'ppid',
  'platform',
  'arch',
  'version',
  'versions',
  'release',
  'cwd',
  'chdir',
  'nextTick',
  'uptime',
  'hrtime',
  'memoryUsage',
  'resourceUsage',
  'cpuUsage',
  'stdout',
  'stderr',
  'stdin',
  'emitWarning',
  'title',
  'kill',
  'umask',
  'features',
  'config',
]);
const LIGHTSHIP_KEYS: ReadonlySet<string> = new Set([
  'shutdownDelay',
  'port',
  'gracefulShutdownTimeout',
  'shutdownHandlerTimeout',
]);
const TERMINUS_KEYS: ReadonlySet<string> = new Set([
  'beforeShutdown',
  'onSignal',
  'onShutdown',
  'onSendFailureDuringShutdown',
  'healthChecks',
  'logger',
  'timeout',
  'sendFailuresDuringShutdown',
  'useExit0',
  'caseInsensitive',
  'statusOk',
  'statusError',
  'signal',
]);

type Fn = Node;
interface Delay {
  readonly ms: number;
  /** The literal the delay was read from: its line is the delay's source. */
  readonly at: Node;
}

function isStringLiteral(node: Node | undefined): node is Node & { getLiteralValue(): string } {
  return (
    node !== undefined && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
  );
}

/** The name of a property key that is a plain identifier or string, or undefined (computed, numeric, ...). */
function plainKeyName(prop: Node): string | undefined {
  if (
    !(
      Node.isPropertyAssignment(prop) ||
      Node.isShorthandPropertyAssignment(prop) ||
      Node.isMethodDeclaration(prop)
    )
  ) {
    return undefined;
  }
  const key = prop.getNameNode();
  if (Node.isIdentifier(key)) return key.getText();
  if (isStringLiteral(key)) return key.getLiteralValue();
  return undefined;
}

export class DrainReader {
  constructor(
    private readonly walk: FileWalk,
    private readonly names: DrainBindings,
  ) {}

  // ------------------------------------------------------------ helpers

  private unresolved(kind: NodeDrainKind, at: Node, reason: string): NodeDrain {
    const source = this.walk.src(at);
    return {
      kind,
      source,
      delay: {
        state: 'unresolved',
        value: this.walk.log.mark('drain-unresolved-duration', source, reason, DRAIN_HINT),
      },
    };
  }

  private literal(kind: NodeDrainKind, site: Node, d: Delay): NodeDrain {
    const delay: NodeDrainDelay = {
      state: 'literal',
      value: makeSourcedValue({
        value: d.ms,
        unit: 'ms',
        source: this.walk.src(d.at),
        basis: 'declared',
      }),
    };
    return { kind, source: this.walk.src(site), delay };
  }

  /** Set while reading a file whose top level exits or throws before it listens: no path is shown to run. */
  private dead = false;

  /** The statement runs from the top of the file as a plain statement (not under a condition, loop or callback). */
  private pathOk(node: Node): boolean {
    if (this.dead) return false;
    const st = statementOf(node);
    const parent = st?.getParent();
    return (
      st !== undefined &&
      parent !== undefined &&
      this.walk.isDirectStatementOf(st, node) &&
      this.walk.plainSequence(parent)
    );
  }

  /** The node is the one listening server of this file, or the result of its `.listen(...)`. */
  private tiedTo(serverKey: string | undefined, node: Node | undefined): boolean {
    if (serverKey === undefined) return false;
    const n = unwrap(node);
    const key = this.walk.keyOf(n);
    if (key === serverKey) return true;
    if (n !== undefined && Node.isIdentifier(n)) {
      const defs = this.walk.defs.get(n.getText());
      const only = defs?.length === 1 ? unwrap(defs[0]) : undefined;
      if (only !== undefined && Node.isCallExpression(only)) {
        const callee = only.getExpression();
        return (
          Node.isPropertyAccessExpression(callee) &&
          callee.getName() === 'listen' &&
          this.walk.keyOf(callee.getExpression()) === serverKey
        );
      }
    }
    return false;
  }

  private isProcess(node: Node | undefined): boolean {
    const n = unwrap(node);
    return n !== undefined && Node.isIdentifier(n) && this.names.processNames.has(n.getText());
  }

  /** An expression that cannot run user code that waits: literals, names, property reads and `+`. */
  private isPure(node: Node | undefined): boolean {
    const n = unwrap(node);
    if (n === undefined) return false;
    if (
      isStringLiteral(n) ||
      Node.isNumericLiteral(n) ||
      Node.isIdentifier(n) ||
      Node.isTrueLiteral(n) ||
      Node.isFalseLiteral(n) ||
      Node.isNullLiteral(n)
    ) {
      return true;
    }
    if (Node.isPropertyAccessExpression(n)) return this.isPure(n.getExpression());
    if (Node.isTemplateExpression(n)) {
      return n.getTemplateSpans().every((s) => this.isPure(s.getExpression()));
    }
    if (Node.isBinaryExpression(n)) return this.isPure(n.getLeft()) && this.isPure(n.getRight());
    return false;
  }

  private isFunctionNode(node: Node | undefined): boolean {
    const n = unwrap(node);
    return n !== undefined && (Node.isArrowFunction(n) || Node.isFunctionExpression(n));
  }

  /** A function written in place, or a name bound once to a local function that is never written to. */
  private functionOf(node: Node | undefined): Fn | undefined {
    const n = unwrap(node);
    if (n === undefined) return undefined;
    if (Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isMethodDeclaration(n)) {
      return n;
    }
    if (!Node.isIdentifier(n)) return undefined;
    const name = n.getText();
    const { vars, funcs } = this.walk.declsNamed(name);
    if (vars.length + funcs.length !== 1 || this.walk.isWrittenTo(name)) return undefined;
    const [func] = funcs;
    if (func !== undefined) return func;
    const only = vars[0];
    if (only === undefined || !Node.isVariableDeclaration(only)) return undefined;
    const list = only.getParent();
    const init = unwrap(only.getInitializer());
    if (
      Node.isVariableDeclarationList(list) &&
      String(list.getDeclarationKind()) === 'const' &&
      init !== undefined &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      return init;
    }
    return undefined;
  }

  // ------------------------------------------------------------ the forms of a delay

  /**
   * `new Promise(r => setTimeout(r, N))`, `new Promise(function (r) { setTimeout(r, N); })`, or a
   * call of `setTimeout` from `timers/promises`. The delay in ms, or undefined.
   */
  private promiseDelay(expr: Node | undefined): Delay | undefined {
    const e = unwrap(expr);
    if (e === undefined) return undefined;
    if (Node.isNewExpression(e)) {
      const callee = e.getExpression();
      const args = e.getArguments();
      const executor = args[0];
      if (!Node.isIdentifier(callee) || callee.getText() !== 'Promise' || args.length !== 1) {
        return undefined;
      }
      if (
        executor === undefined ||
        !(Node.isArrowFunction(executor) || Node.isFunctionExpression(executor))
      ) {
        return undefined;
      }
      const resolver = executor.getParameters()[0]?.getNameNode();
      if (resolver === undefined || !Node.isIdentifier(resolver)) return undefined;
      const body = executor.getBody();
      let call: Node | undefined = body;
      if (Node.isBlock(body)) {
        const only = body.getStatements();
        const st = only.length === 1 ? only[0] : undefined;
        call = st !== undefined && Node.isExpressionStatement(st) ? st.getExpression() : undefined;
      }
      call = unwrap(call);
      if (call === undefined || !Node.isCallExpression(call)) return undefined;
      const fn = call.getExpression();
      const cargs = call.getArguments();
      const first = cargs[0];
      const second = cargs[1];
      const resolved = unwrap(first);
      if (
        !Node.isIdentifier(fn) ||
        fn.getText() !== 'setTimeout' ||
        cargs.length !== 2 ||
        second === undefined ||
        resolved === undefined ||
        !Node.isIdentifier(resolved) ||
        resolved.getText() !== resolver.getText()
      ) {
        return undefined;
      }
      return this.delayOf(second);
    }
    if (Node.isCallExpression(e)) {
      const callee = e.getExpression();
      const args = e.getArguments();
      const named =
        (Node.isIdentifier(callee) && this.names.timerFns.has(callee.getText())) ||
        (Node.isPropertyAccessExpression(callee) &&
          callee.getName() === 'setTimeout' &&
          Node.isIdentifier(callee.getExpression()) &&
          this.names.timerModules.has(callee.getExpression().getText()));
      const first = args[0];
      if (!named || args.length !== 1 || first === undefined) return undefined;
      return this.delayOf(first);
    }
    return undefined;
  }

  private delayOf(node: Node): Delay | undefined {
    const ms = evalLiteral(node);
    if (ms === undefined || ms < 0 || ms > Number.MAX_SAFE_INTEGER) return undefined;
    return { ms, at: node };
  }

  /** The expression a statement of a function body is, or undefined for any other kind of statement. */
  private exprOfStatement(item: Node | undefined): Node | undefined {
    return item !== undefined && Node.isExpressionStatement(item)
      ? unwrap(item.getExpression())
      : undefined;
  }

  /** The body of a function as a list of expressions (undefined for a statement that is not one). */
  private bodyExprs(fn: Node): (Node | undefined)[] | undefined {
    const body =
      Node.isArrowFunction(fn) ||
      Node.isFunctionExpression(fn) ||
      Node.isFunctionDeclaration(fn) ||
      Node.isMethodDeclaration(fn)
        ? fn.getBody()
        : undefined;
    if (body === undefined) return undefined;
    return Node.isBlock(body)
      ? body.getStatements().map((st) => this.exprOfStatement(st))
      : [unwrap(body)];
  }

  private isLog(expr: Node | undefined): boolean {
    if (expr === undefined || !Node.isCallExpression(expr)) return false;
    const callee = expr.getExpression();
    return (
      Node.isPropertyAccessExpression(callee) &&
      LOG_NAMES.has(callee.getName()) &&
      expr.getArguments().every((a) => this.isPure(a))
    );
  }

  /** `<server>.close(...)` on the listening server, or `process.exit(...)`; arguments that cannot wait. */
  private isStop(expr: Node | undefined, serverKey: string | undefined): boolean {
    if (expr === undefined || !Node.isCallExpression(expr)) return false;
    const callee = expr.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return false;
    const target = callee.getExpression();
    const stops =
      (callee.getName() === 'close' && this.tiedTo(serverKey, target)) ||
      (callee.getName() === 'exit' && this.isProcess(target));
    return stops && expr.getArguments().every((a) => this.isPure(a) || this.isFunctionNode(a));
  }

  /** `setTimeout(() => <stop>, N)` (and `.unref()` on it) as a whole statement. */
  private timedStop(expr: Node | undefined, serverKey: string | undefined): Delay | undefined {
    let e = expr;
    if (e !== undefined && Node.isCallExpression(e)) {
      const callee = e.getExpression();
      if (
        Node.isPropertyAccessExpression(callee) &&
        callee.getName() === 'unref' &&
        e.getArguments().length === 0
      ) {
        e = unwrap(callee.getExpression());
      }
    }
    if (e === undefined || !Node.isCallExpression(e)) return undefined;
    const callee = e.getExpression();
    const args = e.getArguments();
    const [cb, time] = args;
    if (
      !Node.isIdentifier(callee) ||
      callee.getText() !== 'setTimeout' ||
      args.length !== 2 ||
      cb === undefined ||
      time === undefined
    ) {
      return undefined;
    }
    const fn = unwrap(cb);
    if (fn === undefined || !(Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
      return undefined;
    }
    const items = this.bodyExprs(fn);
    if (items === undefined) return undefined;
    let stopped = false;
    for (const inner of items) {
      if (inner === undefined) return undefined;
      if (this.isLog(inner)) continue;
      if (!stopped && this.isStop(inner, serverKey)) {
        stopped = true;
        continue;
      }
      return undefined;
    }
    return stopped ? this.delayOf(time) : undefined;
  }

  /** The delay a SIGTERM handler adds before the server stops, or undefined when its body is not read. */
  private handlerDelay(fn: Fn, serverKey: string | undefined): Delay | undefined {
    const items = this.bodyExprs(fn);
    if (items === undefined) return undefined;
    let total = 0;
    let at: Node | undefined;
    for (const [i, expr] of items.entries()) {
      if (expr === undefined) return undefined;
      if (this.isLog(expr)) continue;
      const waited = this.promiseDelay(expr);
      if (waited !== undefined) {
        total += waited.ms;
        at ??= waited.at;
        continue;
      }
      if (this.isStop(expr, serverKey)) return { ms: total, at: at ?? fn };
      const timed = this.timedStop(expr, serverKey);
      if (timed !== undefined) {
        // after a timed stop only logging may follow: a second stop would race it
        for (const later of items.slice(i + 1)) {
          if (!this.isLog(later)) return undefined;
        }
        return { ms: total + timed.ms, at: at ?? timed.at };
      }
      return undefined;
    }
    return undefined; // the body never stops the server in a form that is read
  }

  /** The delay of a terminus `beforeShutdown`: delays and logging only, or a returned delay. */
  private beforeShutdownDelay(fn: Fn): Delay | undefined {
    if (
      !(
        Node.isArrowFunction(fn) ||
        Node.isFunctionExpression(fn) ||
        Node.isFunctionDeclaration(fn) ||
        Node.isMethodDeclaration(fn)
      )
    ) {
      return undefined;
    }
    const body = fn.getBody();
    if (body === undefined) return undefined;
    if (!Node.isBlock(body)) return this.promiseDelay(body);
    let total = 0;
    let at: Node | undefined;
    for (const st of body.getStatements()) {
      if (Node.isReturnStatement(st)) {
        const value = st.getExpression();
        if (value === undefined) break;
        const waited = this.promiseDelay(value);
        if (waited === undefined) return undefined;
        total += waited.ms;
        at ??= waited.at;
        break;
      }
      const expr = this.exprOfStatement(st);
      if (expr === undefined) return undefined;
      if (this.isLog(expr)) continue;
      const waited = this.promiseDelay(expr);
      if (waited === undefined) return undefined;
      total += waited.ms;
      at ??= waited.at;
    }
    return { ms: total, at: at ?? fn };
  }

  // ------------------------------------------------------------ the three sources

  private lightship(call: Node): NodeDrain {
    if (!this.pathOk(call)) {
      return this.unresolved(
        'lightship',
        call,
        'createLightship is not a plain statement run from the top of the file',
      );
    }
    if (!Node.isCallExpression(call)) return this.unresolved('lightship', call, 'not a call');
    const args = call.getArguments();
    if (args.length === 0) return this.defaultLightship(call);
    const opts = unwrap(args[0]);
    if (args.length > 1 || opts === undefined || !Node.isObjectLiteralExpression(opts)) {
      return this.unresolved(
        'lightship',
        call,
        'the createLightship options are not an object written in place',
      );
    }
    let delay: Delay | undefined;
    let seen = false;
    for (const prop of opts.getProperties()) {
      const name = plainKeyName(prop);
      if (name === undefined || !LIGHTSHIP_KEYS.has(name)) {
        return this.unresolved(
          'lightship',
          call,
          'a createLightship option is not one tripcurve reads',
        );
      }
      if (name !== 'shutdownDelay') continue;
      if (seen || !Node.isPropertyAssignment(prop)) {
        return this.unresolved(
          'lightship',
          prop,
          'shutdownDelay is not a number written in the code',
        );
      }
      seen = true;
      const init = prop.getInitializer();
      delay = init === undefined ? undefined : this.delayOf(init);
      if (delay === undefined) {
        return this.unresolved(
          'lightship',
          prop,
          'shutdownDelay is not a number written in the code',
        );
      }
    }
    return delay === undefined
      ? this.defaultLightship(call)
      : this.literal('lightship', call, delay);
  }

  private defaultLightship(call: Node): NodeDrain {
    return {
      kind: 'lightship',
      source: this.walk.src(call),
      delay: { state: 'lightship-default' },
    };
  }

  /** A terminus drain, or undefined when this `createTerminus` has no `beforeShutdown` (so it adds none). */
  private terminus(call: Node, serverKey: string | undefined): NodeDrain | undefined {
    if (!Node.isCallExpression(call)) return undefined;
    const args = call.getArguments();
    if (args.length === 1) return undefined;
    const opts = unwrap(args[1]);
    if (args.length !== 2 || opts === undefined || !Node.isObjectLiteralExpression(opts)) {
      return this.unresolved(
        'terminus',
        call,
        'the createTerminus options are not an object written in place',
      );
    }
    let hook: Node | undefined;
    for (const prop of opts.getProperties()) {
      const name = plainKeyName(prop);
      if (name === undefined || !TERMINUS_KEYS.has(name)) {
        return this.unresolved(
          'terminus',
          call,
          'a createTerminus option is not one tripcurve reads',
        );
      }
      if (name === 'signal') {
        const v = Node.isPropertyAssignment(prop) ? unwrap(prop.getInitializer()) : undefined;
        if (!isStringLiteral(v) || v.getLiteralValue() !== 'SIGTERM') {
          return this.unresolved('terminus', prop, 'terminus is not set to react to SIGTERM');
        }
      }
      if (name === 'beforeShutdown') {
        if (hook !== undefined) {
          return this.unresolved('terminus', prop, 'beforeShutdown is given twice');
        }
        hook = prop;
      }
    }
    if (hook === undefined) return undefined;
    if (!this.pathOk(call)) {
      return this.unresolved(
        'terminus',
        call,
        'createTerminus is not a plain statement run from the top of the file',
      );
    }
    if (!this.tiedTo(serverKey, args[0])) {
      return this.unresolved(
        'terminus',
        call,
        'terminus is not tied to the one listening server of the file',
      );
    }
    const target = Node.isPropertyAssignment(hook)
      ? hook.getInitializer()
      : Node.isShorthandPropertyAssignment(hook)
        ? hook.getNameNode()
        : hook; // a method
    const fn = this.functionOf(target);
    if (fn === undefined) {
      return this.unresolved(
        'terminus',
        hook,
        'beforeShutdown is not a function written in place or a local function',
      );
    }
    const delay = this.beforeShutdownDelay(fn);
    if (delay === undefined) {
      return this.unresolved(
        'terminus',
        hook,
        'beforeShutdown has no delay that is a number written in the code',
      );
    }
    return this.literal('terminus', call, delay);
  }

  private registration(call: Node, serverKey: string | undefined): NodeDrain | undefined {
    if (!Node.isCallExpression(call)) return undefined;
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || !SIGNAL_METHODS.has(callee.getName())) {
      return undefined;
    }
    const args = call.getArguments();
    const first = unwrap(args[0]);
    const onProcess = this.isProcess(callee.getExpression());
    if (!onProcess) {
      // some other object: only a registration for SIGTERM matters, and it is not read
      return isStringLiteral(first) && first.getLiteralValue() === 'SIGTERM'
        ? this.unresolved(
            'sigterm-handler',
            call,
            'a SIGTERM handler is registered on something that is not the process',
          )
        : undefined;
    }
    if (!isStringLiteral(first)) {
      return this.unresolved(
        'sigterm-handler',
        call,
        'a signal handler is registered with a name that is not written in the code',
      );
    }
    if (first.getLiteralValue() !== 'SIGTERM') return undefined;
    if (args.length !== 2 || !this.pathOk(call)) {
      return this.unresolved(
        'sigterm-handler',
        call,
        'the SIGTERM handler is not a plain statement with one handler',
      );
    }
    const fn = this.functionOf(args[1]);
    const delay = fn === undefined ? undefined : this.handlerDelay(fn, serverKey);
    if (delay === undefined) {
      return this.unresolved(
        'sigterm-handler',
        call,
        'the SIGTERM handler is not in a form tripcurve reads',
      );
    }
    return this.literal('sigterm-handler', call, delay);
  }

  // ------------------------------------------------------------ references that are not read

  /** `process` (or `globalThis`) used in a way that could register a handler tripcurve does not read. */
  private processFormNotRead(): Node | undefined {
    for (const id of this.walk.idents('process')) {
      const parent = id.getParent();
      if (parent === undefined) continue;
      if (Node.isPropertyAccessExpression(parent)) {
        if (parent.getNameNode() === id) continue; // `x.process`: a name, not a reference
        const member = parent.getName();
        const call = parent.getParent();
        const callee = Node.isCallExpression(call) && call.getExpression() === parent;
        if (SIGNAL_METHODS.has(member) && callee) continue;
        if (PROCESS_MEMBERS.has(member)) continue;
        return id;
      }
      if (this.isDeclarationName(id)) continue;
      return id;
    }
    for (const name of ['globalThis', 'global']) {
      for (const id of this.walk.idents(name)) {
        const parent = id.getParent();
        if (parent !== undefined && Node.isPropertyAccessExpression(parent)) {
          if (parent.getNameNode() === id || parent.getName() !== 'process') continue;
        }
        if (parent !== undefined && this.isDeclarationName(id)) continue;
        return id;
      }
    }
    return undefined;
  }

  private isDeclarationName(id: Node): boolean {
    const p = id.getParent();
    if (p === undefined) return false;
    return (
      (Node.isVariableDeclaration(p) && p.getNameNode() === id) ||
      (Node.isParameterDeclaration(p) && p.getNameNode() === id) ||
      (Node.isBindingElement(p) && p.getNameNode() === id) ||
      Node.isImportSpecifier(p) ||
      Node.isImportClause(p) ||
      Node.isNamespaceImport(p) ||
      Node.isImportEqualsDeclaration(p) ||
      (Node.isPropertyAssignment(p) && p.getNameNode() === id) ||
      (Node.isMethodDeclaration(p) && p.getNameNode() === id) ||
      (Node.isFunctionDeclaration(p) && p.getNameNode() === id)
    );
  }

  /** A name bound to lightship or terminus that is used other than as `createX(...)` or `M.createX(...)`. */
  private libraryFormNotRead(
    fns: ReadonlySet<string>,
    modules: ReadonlySet<string>,
    member: string,
  ): Node | undefined {
    for (const name of [...fns, ...modules]) {
      for (const id of this.walk.idents(name)) {
        const parent = id.getParent();
        if (parent === undefined || this.isDeclarationName(id)) continue;
        if (fns.has(name)) {
          if (Node.isCallExpression(parent) && parent.getExpression() === id) continue;
          if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) continue;
          return id;
        }
        if (Node.isPropertyAccessExpression(parent)) {
          if (parent.getNameNode() === id) continue;
          const call = parent.getParent();
          if (
            parent.getName() === member &&
            Node.isCallExpression(call) &&
            call.getExpression() === parent
          ) {
            continue;
          }
        }
        return id;
      }
    }
    return undefined;
  }

  // ------------------------------------------------------------ the whole file

  private isCreate(
    call: Node,
    fns: ReadonlySet<string>,
    modules: ReadonlySet<string>,
    member: string,
  ): boolean {
    if (!Node.isCallExpression(call)) return false;
    const callee = call.getExpression();
    if (Node.isIdentifier(callee)) return fns.has(callee.getText());
    return (
      Node.isPropertyAccessExpression(callee) &&
      callee.getName() === member &&
      Node.isIdentifier(callee.getExpression()) &&
      modules.has(callee.getExpression().getText())
    );
  }

  /** Every in-process drain of the file; `serverKey` is the one listening server (see `FileWalk.finalize`). */
  read(serverKey: string | undefined, dead = false): NodeDrain[] {
    this.dead = dead;
    const out: NodeDrain[] = [];
    const lightshipCalls: Node[] = [];
    const terminusCalls: Node[] = [];
    const registrations: Node[] = [];
    let rawProcess: Node | undefined;
    this.walk.sf.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      if (
        this.isCreate(node, this.names.lightshipFns, this.names.lightshipModules, 'createLightship')
      ) {
        lightshipCalls.push(node);
      } else if (
        this.isCreate(node, this.names.terminusFns, this.names.terminusModules, 'createTerminus')
      ) {
        terminusCalls.push(node);
      } else {
        const callee = node.getExpression();
        if (Node.isPropertyAccessExpression(callee) && SIGNAL_METHODS.has(callee.getName())) {
          registrations.push(node);
        } else if (
          Node.isIdentifier(callee) &&
          callee.getText() === 'require' &&
          rawProcess === undefined
        ) {
          const arg = unwrap(node.getArguments()[0]);
          const spec = isStringLiteral(arg) ? arg.getLiteralValue() : undefined;
          const parent = node.getParent();
          if (
            (spec === 'process' || spec === 'node:process') &&
            !(parent !== undefined && Node.isVariableDeclaration(parent))
          ) {
            rawProcess = node;
          }
        }
      }
    });
    if (lightshipCalls.length + terminusCalls.length + registrations.length > MAX_SITES) {
      const first = lightshipCalls[0] ?? terminusCalls[0] ?? registrations[0];
      if (first !== undefined) {
        out.push(
          this.unresolved('sigterm-handler', first, 'too many shutdown registrations to read'),
        );
      }
      return out;
    }
    for (const call of lightshipCalls) out.push(this.lightship(call));
    for (const call of terminusCalls) {
      const found = this.terminus(call, serverKey);
      if (found !== undefined) out.push(found);
    }
    for (const call of registrations) {
      const found = this.registration(call, serverKey);
      if (found !== undefined) out.push(found);
    }
    const bad = rawProcess ?? this.processFormNotRead();
    if (bad !== undefined) {
      out.push(
        this.unresolved(
          'sigterm-handler',
          bad,
          'the process is used in a form tripcurve does not read',
        ),
      );
    }
    const ls = this.libraryFormNotRead(
      this.names.lightshipFns,
      this.names.lightshipModules,
      'createLightship',
    );
    if (ls !== undefined) {
      out.push(
        this.unresolved('lightship', ls, 'lightship is used in a form tripcurve does not read'),
      );
    }
    const tm = this.libraryFormNotRead(
      this.names.terminusFns,
      this.names.terminusModules,
      'createTerminus',
    );
    if (tm !== undefined) {
      out.push(
        this.unresolved('terminus', tm, 'terminus is used in a form tripcurve does not read'),
      );
    }
    return out;
  }
}
