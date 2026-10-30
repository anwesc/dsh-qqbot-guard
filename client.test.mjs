/**
 * 客户端 bundle 冒烟测试。
 *
 * 手写的 `client/client.js` 没有构建流程兜底：语法错误、工厂不返回 exports、
 * 忘了注册 `settings.section`，都只会在真实宿主的设置页里表现为「板块不见了」。
 * 这里用 vm 模拟 DSH 的模块加载器，把这些约定钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const CLIENT_FILE = new URL('./client/client.js', import.meta.url);

/** 最小的 React 替身：只要求工厂能取到这些导出。 */
function fakeReact() {
  const createElement = (type, props) => ({ type, props });
  const hook = () => {};
  return {
    createElement,
    useCallback: (fn) => fn,
    useEffect: hook,
    useMemo: (fn) => fn(),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, hook],
  };
}

/** 在假 window 里执行 bundle，返回它注册的模块。 */
function loadBundle() {
  const loaded = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (module) => loaded.push(module),
      },
    },
    console,
    fetch: () => {
      throw new Error('测试不应发起真实请求');
    },
  };
  runInNewContext(readFileSync(CLIENT_FILE, 'utf8'), sandbox, { filename: 'client.js' });
  assert.equal(loaded.length, 1, 'bundle 应该只注册一个模块');
  return loaded[0];
}

test('client bundle 通过 __ModuleLoader__ 注册 qqbot-guard', () => {
  const module = loadBundle();
  assert.equal(module.id, 'dsh-qqbot-guard');
  assert.equal(typeof module.factory, 'function');
});

test('工厂导出 name / inject / apply，且不依赖宿主之外的模块', () => {
  const module = loadBundle();
  const requested = [];
  const exports = module.factory((id) => {
    requested.push(id);
    if (id !== 'react') throw new Error(`未知模块 ${id}`);
    return fakeReact();
  });
  assert.equal(exports.name, 'dsh-qqbot-guard');
  // vm 里造出来的数组原型不同，比较字符串更稳
  assert.equal(exports.inject.join(','), 'slots,locale');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(requested, ['react']);
});

test('apply 注册设置板块、中英文字典与 effect', () => {
  const module = loadBundle();
  const exports = module.factory(() => fakeReact());

  const registered = { locale: null, slot: null, effect: null };
  const ctx = {
    effect: (fn, label) => {
      registered.effect = label;
      fn();
    },
    locale: {
      register: (ns, dicts) => {
        registered.locale = { ns, dicts };
      },
      bind: (ns) => (key) => `${ns}:${key}`,
    },
    slots: {
      inject: (name, callback) => {
        assert.equal(name, 'settings.section');
        callback();
      },
      register: (options, component) => {
        registered.slot = { options, component };
      },
    },
  };

  exports.apply(ctx);

  assert.equal(registered.effect, 'qqbot-guard: dictionaries');
  assert.equal(registered.locale.ns, 'qqbot-guard');
  assert.equal(typeof registered.locale.dicts.zh.nav, 'string');
  assert.equal(typeof registered.locale.dicts.en.nav, 'string');
  assert.equal(registered.slot.options.name, 'settings.section');
  assert.equal(registered.slot.options.id, 'qqbot-guard');
  assert.equal(typeof registered.slot.options.label(), 'string');
  assert.equal(typeof registered.slot.component, 'function');
});
