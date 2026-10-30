/**
 * 配置层测试：字段校验、原子写、热重载、HTTP 接口。
 *
 * 这些路径以前只能靠手改 JSON，出错时无从判断；现在设置页会直接写它们，
 * 所以每条错误分支都要有用例兜住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  DEFAULT_CONFIG,
  createConfigSource,
  installConfigApi,
  isSameOrigin,
  sanitizeConfigPatch,
  writeConfigFile,
} from './index.js';

/** 建一个临时 DSH_HOME，把路径类测试都圈在里面；异步用例等它跑完再清理。 */
function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'qqbot-guard-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const cleanup = () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  };
  let result;
  try {
    result = run(home);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === 'function') return result.finally(cleanup);
  cleanup();
  return result;
}

function quietLogger() {
  const lines = [];
  return {
    lines,
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
    debug: () => {},
  };
}

/** 假请求：只带 handler 需要的字段。 */
function fakeRequest({ method = 'GET', headers = {}, body = '' } = {}) {
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body)]);
  stream.method = method;
  stream.headers = { host: '127.0.0.1:3081', ...headers };
  return stream;
}

/** 假响应：收集 status / headers / body。 */
function fakeResponse() {
  const out = { status: 0, headers: {}, body: '' };
  out.writeHead = (status, headers) => {
    out.status = status;
    out.headers = headers ?? {};
  };
  out.end = (chunk) => {
    out.body += chunk ?? '';
  };
  return out;
}

test('sanitizeConfigPatch 只收已知字段并去重关键词', () => {
  const patch = sanitizeConfigPatch({
    triggers: ['  鱼鱼 ', '肥鱼', '鱼鱼', ''],
    faces: 0,
    ignoreCase: 'yes',
    historyMediaMaxMB: '32',
    qqbotPackage: '  /opt/qqbot  ',
    bogus: '忽略我',
    configFile: '/etc/passwd',
  });
  assert.deepEqual(patch, {
    triggers: ['鱼鱼', '肥鱼'],
    faces: false,
    ignoreCase: true,
    historyMediaMaxMB: 32,
    qqbotPackage: '/opt/qqbot',
  });
  assert.equal('bogus' in patch, false);
  assert.equal('configFile' in patch, false, 'configFile 不允许从 UI 改');
});

test('sanitizeConfigPatch 对坏输入给出可读错误', () => {
  assert.throws(() => sanitizeConfigPatch(null), /JSON 对象/);
  assert.throws(() => sanitizeConfigPatch([]), /JSON 对象/);
  assert.throws(() => sanitizeConfigPatch({ triggers: '鱼鱼' }), /字符串数组/);
  assert.throws(() => sanitizeConfigPatch({ historyMediaMaxMB: 0 }), /historyMediaMaxMB/);
  assert.throws(() => sanitizeConfigPatch({ historyMediaMaxMB: 'abc' }), /historyMediaMaxMB/);
});

test('writeConfigFile 原子写入并可被 mergeConfig 读回', () => {
  withHome((home) => {
    const file = join(home, 'qqbot-guard.json');
    writeConfigFile(file, { triggers: ['鱼鱼'], faces: false });
    assert.equal(existsSync(file), true);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(parsed, { triggers: ['鱼鱼'], faces: false });

    const source = createConfigSource({}, quietLogger());
    assert.equal(source.file, file);
    const merged = source.get();
    assert.deepEqual(merged.triggers, ['鱼鱼']);
    assert.equal(merged.faces, false);
    assert.equal(merged.enabled, DEFAULT_CONFIG.enabled);
  });
});

test('createConfigSource 在文件变化后热重载', () => {
  withHome((home) => {
    const file = join(home, 'qqbot-guard.json');
    writeConfigFile(file, { triggers: ['旧词'] });
    const logger = quietLogger();
    const source = createConfigSource({}, logger);
    assert.deepEqual(source.get().triggers, ['旧词']);

    // 同长度不同内容 + 改 mtime：靠 mtime 触发重载
    writeFileSync(file, JSON.stringify({ triggers: ['新词'] }));
    const future = new Date(Date.now() + 5000);
    // 显式改时间，避免文件系统 mtime 精度导致「没变」
    utimesSync(file, future, future);

    assert.deepEqual(source.get().triggers, ['新词']);
    assert.ok(logger.lines.some((line) => line.includes('配置已重新加载')));
  });
});

test('isSameOrigin 只接受本机回环', () => {
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:3081' } }), true);
  assert.equal(isSameOrigin({ headers: { host: 'localhost:3081' } }), true);
  assert.equal(isSameOrigin({ headers: { host: 'localhost:3081', origin: 'http://localhost:3081' } }), true);
  assert.equal(isSameOrigin({ headers: { host: 'localhost:3081', origin: 'http://evil.example' } }), false);
  assert.equal(isSameOrigin({ headers: { host: '192.168.1.5:3081' } }), false);
  assert.equal(isSameOrigin({ headers: {} }), false);
});

test('installConfigApi 注册路由，GET 返回配置、PUT 落盘', async () => {
  await withHome(async (home) => {
    const file = join(home, 'qqbot-guard.json');
    writeConfigFile(file, { triggers: ['鱼鱼'] });
    const logger = quietLogger();
    const source = createConfigSource({}, logger);
    const status = { qqbot: '/opt/qqbot', installed: true };

    let route;
    const ctx = {
      inject: (services, callback) => {
        assert.deepEqual(services, ['webServer']);
        callback({
          webServer: {
            register: (registered) => {
              route = registered;
              return () => {};
            },
          },
        });
      },
    };
    assert.equal(installConfigApi(ctx, source, logger, status, { verbose: false }), true);
    assert.equal(route.kind, 'exact');
    assert.equal(route.path, '/qqbot-guard/config');

    const getRes = fakeResponse();
    await route.handler(fakeRequest(), getRes);
    assert.equal(getRes.status, 200);
    const payload = JSON.parse(getRes.body);
    assert.deepEqual(payload.config.triggers, ['鱼鱼']);
    assert.equal(payload.status.qqbot, '/opt/qqbot');
    assert.equal(payload.file, file);
    // cordis 的字段优先级高于 JSON 文件，设置页要能看出来哪些改了不生效
    assert.deepEqual(payload.overridden, ['verbose']);

    const putRes = fakeResponse();
    await route.handler(
      fakeRequest({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ triggers: ['新词', '新词'], faces: false }),
      }),
      putRes,
    );
    assert.equal(putRes.status, 200);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(saved.triggers, ['新词']);
    assert.equal(saved.faces, false);

    // 保存后热重载立即生效
    assert.deepEqual(source.get().triggers, ['新词']);
    assert.equal(source.get().faces, false);
  });
});

test('installConfigApi 拒绝跨站来源与坏请求体', async () => {
  await withHome(async (home) => {
    const logger = quietLogger();
    const source = createConfigSource({}, logger);
    let route;
    const ctx = {
      inject: (_services, callback) => callback({ webServer: { register: (r) => ((route = r), () => {}) } }),
    };
    installConfigApi(ctx, source, logger, {});

    const forbidden = fakeResponse();
    await route.handler(fakeRequest({ headers: { origin: 'http://evil.example' } }), forbidden);
    assert.equal(forbidden.status, 403);

    const bad = fakeResponse();
    await route.handler(fakeRequest({ method: 'PUT', body: '{oops' }), bad);
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.body).error, /JSON/);

    const wrongType = fakeResponse();
    await route.handler(fakeRequest({ method: 'PUT', body: JSON.stringify({ triggers: 1 }) }), wrongType);
    assert.equal(wrongType.status, 400);
    assert.match(JSON.parse(wrongType.body).error, /字符串数组/);

    const missing = fakeResponse();
    await route.handler(fakeRequest({ method: 'DELETE' }), missing);
    assert.equal(missing.status, 405);
  });
});
