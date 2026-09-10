import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { extractCoverData } from './cover';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-reader-cover-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function writeZip(name: string, entries: Record<string, Buffer | string>): Promise<string> {
  const zip = new JSZip();
  for (const [entry, content] of Object.entries(entries)) zip.file(entry, content);
  const out = await zip.generateAsync({ type: 'nodebuffer' });
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, out);
  return p;
}

/** 构造一个最小可用的 EPUB：container.xml + OPF（含 meta[name=cover]）+ 封面图 */
async function makeEpub(opts?: { coverId?: string; coverHref?: string; withMeta?: boolean }) {
  const coverId = opts?.coverId ?? 'cover-img';
  const coverHref = opts?.coverHref ?? 'images/cover.png';
  const meta = opts?.withMeta === false ? '' : `<meta name="cover" content="${coverId}"/>`;
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata>${meta}<dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">测试书</dc:title></metadata>
  <manifest>
    <item id="${coverId}" href="${coverHref}" media-type="image/png"/>
    <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
  return writeZip('book.epub', {
    'META-INF/container.xml':
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    'OEBPS/content.opf': opf,
    [`OEBPS/${coverHref}`]: PNG,
    'OEBPS/Text/ch1.xhtml': '<html><body>正文</body></html>',
  });
}

describe('EPUB 封面', () => {
  it('按 OPF 的 meta[name=cover] 取图', async () => {
    const p = await makeEpub();
    const cover = await extractCoverData(p, '.epub');
    expect(cover?.ext).toBe('.png');
    expect(cover?.data).toEqual(PNG);
  });

  it('无 meta 时按 id/href 含 cover 的图片条目兜底', async () => {
    const p = await makeEpub({ coverId: 'cover-image', coverHref: 'img/cover.png', withMeta: false });
    const cover = await extractCoverData(p, '.epub');
    expect(cover?.data).toEqual(PNG);
  });

  it('无任何封面图返回 null', async () => {
    const p = await writeZip('nocover.epub', {
      'META-INF/container.xml':
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
      'content.opf':
        '<?xml version="1.0"?><package><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest></package>',
      'ch1.xhtml': '<html><body>x</body></html>',
    });
    expect(await extractCoverData(p, '.epub')).toBeNull();
  });

  it('container.xml 缺失返回 null', async () => {
    const p = await writeZip('broken.epub', { 'content.opf': '<package/>' });
    expect(await extractCoverData(p, '.epub')).toBeNull();
  });

  it('.jpeg 统一为 .jpg 扩展名', async () => {
    const p = await makeEpub({ coverHref: 'images/cover.jpeg' });
    const cover = await extractCoverData(p, '.epub');
    expect(cover?.ext).toBe('.jpg');
    expect(cover?.data).toEqual(PNG);
  });
});

describe('CBZ 封面', () => {
  it('取自然序第一张图', async () => {
    const p = await writeZip('comic.cbz', {
      'p10.png': PNG,
      'p2.png': PNG,
      'p1.png': Buffer.from([0x01]),
      'info.txt': 'x',
    });
    const cover = await extractCoverData(p, '.cbz');
    expect(cover?.ext).toBe('.png');
    // p1.png 内容为单字节，验证取到的确实是自然序第一张而非字典序第一张
    expect(cover?.data).toEqual(Buffer.from([0x01]));
  });

  it('无图片返回 null', async () => {
    const p = await writeZip('empty.cbz', { 'readme.txt': 'x' });
    expect(await extractCoverData(p, '.cbz')).toBeNull();
  });
});

describe('不支持的格式', () => {
  it('TXT 与 PDF 返回 null', async () => {
    const p = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(p, '正文');
    expect(await extractCoverData(p, '.txt')).toBeNull();
    expect(await extractCoverData(p, '.pdf')).toBeNull();
  });
});
