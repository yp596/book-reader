import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import {
  parsePageRange,
  mergePdfs,
  extractPages,
  deletePages,
  rotatePages,
  cropPages,
  addWatermark,
  addPageNumbers,
} from './pdf-edit';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-reader-pdf-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 造一个指定页数的空 PDF */
async function makePdf(name: string, pages: number): Promise<string> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 300]);
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, await doc.save());
  return p;
}

const pageCount = async (p: string) => (await PDFDocument.load(fs.readFileSync(p))).getPageCount();

describe('parsePageRange', () => {
  it('空串表示全部页', () => {
    expect(parsePageRange('', 3)).toEqual([0, 1, 2]);
  });

  it('单页与区间混合，去重并升序', () => {
    expect(parsePageRange('3,1-2,2', 5)).toEqual([0, 1, 2]);
  });

  it('开区间到末页', () => {
    expect(parsePageRange('3-', 5)).toEqual([2, 3, 4]);
  });

  it('超出总页数的部分被丢掉', () => {
    expect(parsePageRange('2-99', 3)).toEqual([1, 2]);
    expect(parsePageRange('99', 3)).toEqual([]);
  });

  it('识别全角逗号与中文顿号', () => {
    expect(parsePageRange('1，3、5', 5)).toEqual([0, 2, 4]);
  });

  it('无法识别的写法直接报错', () => {
    expect(() => parsePageRange('abc', 3)).toThrow();
  });
});

describe('合并', () => {
  it('按顺序拼接，页数为两者之和', async () => {
    const a = await makePdf('a.pdf', 2);
    const b = await makePdf('b.pdf', 3);
    const out = path.join(tmpDir, 'merged.pdf');
    expect(await mergePdfs([a, b], out)).toBe(5);
    expect(await pageCount(out)).toBe(5);
  });

  it('没有源文件时报错', async () => {
    await expect(mergePdfs([], path.join(tmpDir, 'x.pdf'))).rejects.toThrow();
  });
});

describe('抽取与删除', () => {
  it('抽取指定页', async () => {
    const src = await makePdf('src.pdf', 5);
    const out = path.join(tmpDir, 'pick.pdf');
    expect(await extractPages(src, '2,4-5', out)).toBe(3);
    expect(await pageCount(out)).toBe(3);
  });

  it('页码范围为空时报错', async () => {
    const src = await makePdf('src.pdf', 3);
    await expect(extractPages(src, '99', path.join(tmpDir, 'o.pdf'))).rejects.toThrow();
  });

  it('删除指定页', async () => {
    const src = await makePdf('src.pdf', 4);
    const out = path.join(tmpDir, 'del.pdf');
    expect(await deletePages(src, '1,3', out)).toBe(2);
    expect(await pageCount(out)).toBe(2);
  });

  it('不允许删光所有页', async () => {
    const src = await makePdf('src.pdf', 2);
    await expect(deletePages(src, '1-2', path.join(tmpDir, 'o.pdf'))).rejects.toThrow();
  });
});

describe('旋转与裁剪', () => {
  it('旋转角度会累加到页面上', async () => {
    const src = await makePdf('src.pdf', 2);
    const out = path.join(tmpDir, 'rot.pdf');
    await rotatePages(src, '', 90, out);
    const doc = await PDFDocument.load(fs.readFileSync(out));
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    expect(doc.getPage(1).getRotation().angle).toBe(90);
    // 再转一次应叠加
    await rotatePages(out, '', 90, out);
    const again = await PDFDocument.load(fs.readFileSync(out));
    expect(again.getPage(0).getRotation().angle).toBe(180);
  });

  it('非法角度报错', async () => {
    const src = await makePdf('src.pdf', 1);
    await expect(rotatePages(src, '', 45, path.join(tmpDir, 'o.pdf'))).rejects.toThrow();
  });

  it('裁剪后裁剪框小于原始尺寸', async () => {
    const src = await makePdf('src.pdf', 1);
    const out = path.join(tmpDir, 'crop.pdf');
    await cropPages(src, '', 10, out);
    const doc = await PDFDocument.load(fs.readFileSync(out));
    const box = doc.getPage(0).getCropBox();
    expect(box.width).toBeLessThan(200);
    expect(box.height).toBeLessThan(300);
  });
});

describe('水印与页码', () => {
  it('英文水印可写入且不改变页数', async () => {
    const src = await makePdf('src.pdf', 2);
    const out = path.join(tmpDir, 'wm.pdf');
    expect(await addWatermark(src, 'CONFIDENTIAL', out)).toBe(2);
    expect(await pageCount(out)).toBe(2);
  });

  it('中文水印给出可理解的提示而不是原始报错', async () => {
    const src = await makePdf('src.pdf', 1);
    await expect(addWatermark(src, '内部资料', path.join(tmpDir, 'o.pdf'))).rejects.toThrow(
      /内置字体不支持/,
    );
  });

  it('空水印文字报错', async () => {
    const src = await makePdf('src.pdf', 1);
    await expect(addWatermark(src, '  ', path.join(tmpDir, 'o.pdf'))).rejects.toThrow();
  });

  it('加页码不改变页数', async () => {
    const src = await makePdf('src.pdf', 3);
    const out = path.join(tmpDir, 'pn.pdf');
    expect(await addPageNumbers(src, out)).toBe(3);
    expect(await pageCount(out)).toBe(3);
  });
});

describe('加密文档', () => {
  it('读取失败时报错信息可读', async () => {
    const broken = path.join(tmpDir, 'broken.pdf');
    fs.writeFileSync(broken, Buffer.from('not a pdf'));
    await expect(extractPages(broken, '1', path.join(tmpDir, 'o.pdf'))).rejects.toThrow(/无法读取 PDF/);
  });
});
