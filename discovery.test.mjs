/**
 * qqbot 定位逻辑的回归测试（不需要真的装 qqbot，全部在 tmp 目录里造布局）。
 *
 * 用法：node --test plugins/qqbot-guard/discovery.test.mjs
 *
 * 背景：现场环境里 guard 与 qqbot 都装在 `<home>/profiles/<name>/node_modules`，
 * 而旧版 findQqbotPackage() 的候选列表里没有这一层，于是插件在第一步就 return，
 * 关键词检索 / 原型补丁 / 历史附件全都不生效。第一个用例就是这个场景。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  findQqbotPackage,
  locateSelfLayout,
  qqbotCandidates,
} from './index.js';

const QQBOT_PKG = '@tencent-connect/dsh-qqbot';
const GUARD_PKG = 'dsh-qqbot-guard';

const silent = { info() {}, warn() {}, error() {}, debug() {}, log() {} };

/** 造一个最小的包目录：只有 package.json（定位逻辑只看 name）。 */
function makePackage(dir, name, version = '0.5.3') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }, null, 2));
  return dir;
}

/** 每个用例一个临时根目录，结束时删掉。 */
function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-guard-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 清掉可能干扰探测的环境变量，并把 home 兜底指到一个空目录。 */
function isolate(t, extraEnv = {}) {
  const saved = {};
  for (const key of ['DSH_HOME', 'DSH_QQBOT_DIR']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(extraEnv)) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('profile 布局：guard 与 qqbot 同在 profiles/web/node_modules（现场故障）', (t) => {
  const root = makeRoot(t);
  isolate(t);
  const home = join(root, 'home');
  const nm = join(home, 'profiles', 'web', 'node_modules');
  makePackage(join(nm, GUARD_PKG), GUARD_PKG, '0.1.0');
  const qqbot = makePackage(join(nm, QQBOT_PKG), QQBOT_PKG);
  const selfFile = join(nm, GUARD_PKG, 'index.js');
  const cwd = join(root, 'work'); // 现场 cwd 是 /root/work，不含有 node_modules
  mkdirSync(cwd, { recursive: true });

  const hit = findQqbotPackage(DEFAULT_CONFIG, silent, {
    selfFile,
    cwd,
    fallbackHome: join(root, 'no-such-dsh'),
  });

  assert.ok(hit, '应该能靠自身安装位置找到 qqbot');
  assert.equal(hit.pkg.name, QQBOT_PKG);
  assert.equal(hit.dir, qqbot);
});

test('locateSelfLayout 从安装位置反推 home / profile', () => {
  const layout = locateSelfLayout(
    '/root/.dsh/profiles/web/node_modules/dsh-qqbot-guard/index.js',
  );
  assert.equal(layout.home, '/root/.dsh');
  assert.equal(layout.profile, 'web');
  assert.equal(layout.profileDir, '/root/.dsh/profiles/web');
});

test('候选顺序：显式配置 > 同 profile > 其他 home 布局 > cwd', (t) => {
  const root = makeRoot(t);
  isolate(t);
  const home = join(root, 'home');
  const nm = join(home, 'profiles', 'web', 'node_modules');
  makePackage(join(nm, GUARD_PKG), GUARD_PKG);
  makePackage(join(nm, QQBOT_PKG), QQBOT_PKG);

  const candidates = qqbotCandidates(
    { ...DEFAULT_CONFIG, qqbotPackage: '/explicit/qqbot' },
    { selfFile: join(nm, GUARD_PKG, 'index.js'), cwd: join(root, 'work'), fallbackHome: home },
  );

  assert.equal(candidates[0], '/explicit/qqbot');
  const profileHit = candidates.indexOf(join(nm, QQBOT_PKG));
  const cwdHit = candidates.indexOf(join(root, 'work', 'node_modules', QQBOT_PKG));
  assert.ok(profileHit > 0, '同 profile 的 node_modules 应在候选里');
  assert.ok(profileHit < cwdHit, '同 profile 的优先级应高于 cwd');
  assert.equal(new Set(candidates).size, candidates.length, '候选不应重复');
});

test('DSH_HOME 下的 profiles/*/node_modules 也能找到（guard 不在 profile 里时）', (t) => {
  const root = makeRoot(t);
  const home = join(root, 'home');
  isolate(t, { DSH_HOME: home });
  const qqbot = makePackage(
    join(home, 'profiles', 'another', 'node_modules', QQBOT_PKG),
    QQBOT_PKG,
  );

  const hit = findQqbotPackage(DEFAULT_CONFIG, silent, {
    selfFile: join(root, 'checkout', 'plugins', 'qqbot-guard', 'index.js'),
    cwd: join(root, 'work'),
    fallbackHome: join(root, 'no-such-dsh'),
  });

  assert.ok(hit);
  assert.equal(hit.dir, qqbot);
});

test('pnpm 布局：只有 .pnpm store 里存在也能找到', (t) => {
  const root = makeRoot(t);
  const home = join(root, 'home');
  isolate(t, { DSH_HOME: home });
  const nm = join(home, 'profiles', 'web', 'node_modules');
  const store = join(nm, '.pnpm', '@tencent-connect+dsh-qqbot@0.5.3', 'node_modules', QQBOT_PKG);
  const qqbot = makePackage(store, QQBOT_PKG);

  const hit = findQqbotPackage(DEFAULT_CONFIG, silent, {
    selfFile: join(root, 'checkout', 'plugins', 'qqbot-guard', 'index.js'),
    cwd: join(root, 'work'),
    fallbackHome: join(root, 'no-such-dsh'),
  });

  assert.ok(hit, '应能在 .pnpm store 里找到');
  assert.equal(hit.dir, qqbot);
});

test('DSH_QQBOT_DIR 仍然有效', (t) => {
  const root = makeRoot(t);
  isolate(t);
  const qqbot = makePackage(join(root, 'somewhere', QQBOT_PKG), QQBOT_PKG);
  process.env.DSH_QQBOT_DIR = qqbot;

  const hit = findQqbotPackage(DEFAULT_CONFIG, silent, {
    selfFile: join(root, 'checkout', 'plugins', 'qqbot-guard', 'index.js'),
    cwd: join(root, 'work'),
    fallbackHome: join(root, 'no-such-dsh'),
  });

  assert.ok(hit);
  assert.equal(hit.dir, qqbot);
});

test('找不到时返回 null，且 warn 列出试过的路径（可诊断）', (t) => {
  const root = makeRoot(t);
  isolate(t);
  const warnings = [];
  const logger = { ...silent, warn: (m) => warnings.push(m) };
  const nm = join(root, 'home', 'profiles', 'web', 'node_modules');

  const hit = findQqbotPackage(DEFAULT_CONFIG, logger, {
    selfFile: join(nm, GUARD_PKG, 'index.js'),
    cwd: join(root, 'work'),
    fallbackHome: join(root, 'no-such-dsh'),
  });

  assert.equal(hit, null);
  assert.equal(warnings.length, 1);
  // 统一成 POSIX 再断言：Windows 上日志里是反斜杠
  const text = warnings[0].replace(/\\/g, '/');
  assert.match(text, /没找到 @tencent-connect\/dsh-qqbot/);
  // 关键：失败信息要能自己解释「试过哪里」，而不是只报一句没找到
  assert.match(text, /profiles\/web\/node_modules/);
  assert.match(text, /qqbotPackage/);
});
