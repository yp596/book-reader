import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// 下载目录挂在 app.getPath 上；正式代码里那是 Electron 的用户数据目录
const tmpRoot = path.join(os.tmpdir(), 'book-reader-model-test');
vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'book-reader-model-test') },
  BrowserWindow: class {},
}));

/** 收口逻辑挂在响应流上的 'error' 处理器。由测试决定何时触发 */
const errorHandlers: ((err: Error) => void)[] = [];

/** 收口逻辑挂在响应流上的 'data' 处理器，用来确认数据确实被接走了 */
const dataHandlers: ((chunk: any) => void)[] = [];

/** 每次测试换一个「响应对象」，由测试自己决定怎么把它弄坏 */
let currentRes: PassThrough & { statusCode?: number; headers: Record<string, string> } | null = null;

vi.mock('https', () => ({
  default: {
    get: (_url: string, _opts: any, cb: any) => {
      const req = new EventEmitter() as any;
      req.setTimeout = vi.fn();
      req.destroy = vi.fn();
      // 异步回调，与真实 https.get 一致：测试要等一次微任务之后才拿得到 res
      queueMicrotask(() => cb(currentRes));
      return req;
    },
  },
}));

// 联网开关默认开着，否则下载在第一行就被拦下，测不到流中断
vi.mock('./db.service', () => ({
  DatabaseService: {
    getInstance: () => ({ assertOnlineEnabled: () => {} }),
  },
}));

const { ModelService } = await import('./model-service');

/**
 * 真实代码会 await 一次 IO 才会去挂监听，测试得先用微任务把控制权交回去。
 * 写死轮数太脆，这里按「监听器有没有挂上」来收敛。
 */
async function settleUntilReady(ready: () => boolean, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    if (ready()) return;
    await Promise.resolve();
  }
  throw new Error('等不到收口逻辑挂上监听器，测试的时序不对');
}

/** 造一个和 https 响应同接口的假响应：能 pipe、能按需造数据/断流 */
function makeRes(statusCode = 200, headers: Record<string, string> = { 'content-length': '10' }) {
  const res = new PassThrough({ highWaterMark: 1024 * 1024 }) as any;
  res.statusCode = statusCode;
  res.headers = headers;
  res.pause = () => res;
  res.resume = () => res;
  // 收口逻辑挂的两个监听器自己记下来；pipe 要用的 'end'/'data' 照常转发给 PassThrough，
  // 否则 file.on('finish') 永不触发，rename 不会发生，Promise 也永远不落定
  const origOn = res.on.bind(res);
  res.on = (ev: string, fn: any) => {
    if (ev === 'error') { errorHandlers.push(fn); return res; }
    if (ev === 'data') dataHandlers.push(fn);
    return origOn(ev, fn);
  };
  return res;
}

/** 模拟断流：直接触发正式代码挂上的那个处理器，绕过 EventEmitter 的派发细节 */
function fireError(message: string) {
  if (errorHandlers.length === 0) throw new Error('还没挂上错误处理器，测试的时序不对');
  for (const fn of errorHandlers) fn(new Error(message));
}

/**
 * 让「响应回调拿到的那个 res」从头到尾就是同一个对象。
 * 每次测试新建一个的话，回调里绑定的还是上一个（已结束的）流，
 * 之后造的数据和断流都落不到监听器上，测试会挂着直到超时。
 */
function prepareRes(statusCode = 200, headers: Record<string, string> = { 'content-length': '10' }) {
  const res = makeRes(statusCode, headers);
  currentRes = res;
  return res;
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  currentRes = null;
  errorHandlers.length = 0;
  dataHandlers.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('模型下载的失败收口', () => {
  it('响应流中途出错时 Promise 必须落定，而不是永远挂着', async () => {
    const svc = ModelService.getInstance();
    prepareRes();

    const p = svc.downloadModel('chat').catch(e => e);
    await settleUntilReady(() => errorHandlers.length > 0);

    // 先让数据流起来，再从上游客厅断开——这正是之前漏掉的分支：
    // pipe 只搬运数据、不转发错误，不监听 res 的 error 就没人 reject
    currentRes!.write('12345');
    // 收口逻辑自己的 data 监听器在跑（进度统计），另有 pipe 转发给写文件流的那份
    expect(dataHandlers.some(h => h.name !== 'ondata')).toBe(true);
    fireError('socket hang up');

    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('socket hang up');
  });

  it('失败后不留 .part 残骸，重试能正常开始', async () => {
    const svc = ModelService.getInstance();
    prepareRes();

    const first = svc.downloadModel('chat').catch(e => e);
    await settleUntilReady(() => errorHandlers.length > 0);
    currentRes!.write('12345');
    fireError('socket hang up');
    await first;

    // 临时文件残留会让下次下载分不清「没下完」和「下完了」，必须清掉
    // （unlink 是异步的，等一拍再查）
    await new Promise(r => setTimeout(r, 50));
    const leftovers = fs.existsSync(tmpRoot) ? fs.readdirSync(path.join(tmpRoot, 'models')) : [];
    expect(leftovers.filter(f => f.endsWith('.part'))).toEqual([]);

    // 落定即释放：否则之后永远报「下载进行中，请稍候」
    // 第二次下载不能真的跑完（会写文件、发进度），挂上监听器就算证明它进来了
    errorHandlers.length = 0;
    const second = svc.downloadModel('chat').catch(e => e);
    await settleUntilReady(() => errorHandlers.length > 0);
    fireError('收工');
    await expect(second).resolves.toBeInstanceOf(Error);
  });

  it('HTTP 非 200 也走同一条收口路径，不留临时文件', async () => {
    const svc = ModelService.getInstance();
    prepareRes(404, {});

    await expect(svc.downloadModel('chat')).rejects.toThrow(/HTTP 404/);

    await new Promise(r => setTimeout(r, 50));
    const dir = path.join(tmpRoot, 'models');
    const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(leftovers.filter(f => f.endsWith('.part'))).toEqual([]);
  });
});
