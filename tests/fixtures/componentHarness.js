const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function compileComponent(file, mocks = {}, globals = {}, appendedSource = "", transform = source => source) {
  const filename = path.resolve(__dirname, "../..", file);
  const source = transform(fs.readFileSync(filename, "utf8") + appendedSource);
  const exported = {};
  vm.runInNewContext(ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    exports: exported, console, Date, Map, Set, Promise, Error, TypeError, DOMException,
    Request, Response, Headers, AbortController, Uint8Array, setTimeout, clearTimeout,
    performance, URLSearchParams,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (mocks.fallback) return mocks.fallback(name);
      throw new Error(`Unmocked dependency: ${name}`);
    },
    ...globals
  }, { filename });
  return exported;
}

function hookHarness(contextValue = () => null) {
  const slots = [];
  let cursor = 0;
  let pending = [];
  const changed = (before, after) => !before || !after || after.some((value, index) => value !== before[index]);
  const react = {
    createContext: () => ({ Provider: "provider" }),
    useContext: () => contextValue(),
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, next => { slots[index].value = typeof next === "function" ? next(slots[index].value) : next; }];
    },
    useRef(current) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current };
      return slots[index];
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps)) {
        const previous = slots[index];
        slots[index] = { deps };
        pending.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); });
      }
    }
  };
  react.useLayoutEffect = react.useEffect;
  return {
    react, slots,
    render(Component, props = {}, commit = () => {}) {
      cursor = 0;
      const tree = Component(props);
      commit(tree);
      const effects = pending;
      pending = [];
      effects.forEach(effect => effect());
      return tree;
    },
    unmount() { slots.forEach(slot => slot.cleanup?.()); }
  };
}

const jsx = (type, props, key) => ({ type, props, key });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: "fragment" };
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !value.props) return [];
  return [value, ...["children", "left", "right", "answerZone"].flatMap(key => nodes(value.props[key]))];
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value === undefined || value === null || typeof value === "boolean") return "";
  if (typeof value !== "object") return String(value);
  if (typeof value.type === "function") return text(value.type(value.props));
  return text(value.props?.children);
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

module.exports = { compileComponent, hookHarness, jsxRuntime, nodes, text, flush, deferred };
