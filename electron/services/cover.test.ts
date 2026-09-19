import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { extractCoverData, openBookImages } from './cover';

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

describe('漫画包封面（四种容器共用同一路径）', () => {
  /**
   * 构造最小 tar：512 字节定长头 + 内容块（补齐到 512）+ 两个全零结束块。
   * 'ustar' 标记必须落在偏移 257——comic.ts 的 detectArchiveKind 就是靠它认出 tar 的。
   */
  function makeTar(entries: { name: string; data: Buffer }[]): Buffer {
    const blocks: Buffer[] = [];
    for (const e of entries) {
      const header = Buffer.alloc(512);
      header.write(e.name, 0, 'utf8');
      header.write(e.data.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
      header.write('0', 156, 'utf8'); // 常规文件
      header.write('ustar', 257, 'utf8');
      blocks.push(header, e.data, Buffer.alloc(Math.ceil(e.data.length / 512) * 512 - e.data.length));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
  }

  it('CBT（tar）与 CBZ 走同一条路，取自然序第一张图', async () => {
    const p = path.join(tmpDir, 'comic.cbt');
    fs.writeFileSync(
      p,
      makeTar([
        { name: 'p10.png', data: PNG },
        { name: 'p2.png', data: Buffer.from([0x02]) },
        { name: 'info.txt', data: Buffer.from('x') },
      ]),
    );
    const cover = await extractCoverData(p, '.cbt');
    expect(cover?.ext).toBe('.png');
    // 取到的是自然序第一张 p2.png，证明 tar 也走漫画包这条路（此前 .cbt 落到 default 返回 null）
    expect(cover?.data).toEqual(Buffer.from([0x02]));
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

describe('内嵌图片提取（openBookImages）', () => {
  /**
   * 含三张图的 EPUB：两张在 images/ 下、一张在顶层。
   * withGhost 时额外声明一个包里并不存在的条目——OPF 与实际内容不一致的电子书很常见，
   * 必须当「没有这张图」处理，而不是列出来再读成 null。
   */
  async function makeMultiImageEpub(withGhost = false) {
    const ghost = withGhost
      ? '<item id="ghost" href="images/ghost.png" media-type="image/png"/>'
      : '';
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">图册</dc:title></metadata>
  <manifest>
    <item id="i1" href="images/fig2.png" media-type="image/png"/>
    <item id="i2" href="images/fig10.png" media-type="image/png"/>
    <item id="i3" href="top.jpg" media-type="image/jpeg"/>
    <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    ${ghost}
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
    return writeZip('multi.epub', {
      'META-INF/container.xml':
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      'OEBPS/content.opf': opf,
      'OEBPS/images/fig2.png': Buffer.from([0x02]),
      'OEBPS/images/fig10.png': Buffer.from([0x0a]),
      'OEBPS/top.jpg': Buffer.from([0xff, 0xd8]),
      'OEBPS/Text/ch1.xhtml': '<html><body>正文</body></html>',
    });
  }

  it('EPUB 列出全部图片而不只是封面，且按自然序', async () => {
    const imgs = await openBookImages(await makeMultiImageEpub(), 'epub');
    // 自然序：fig2 排在 fig10 前面（纯字典序会反过来），复用漫画那边同一套比较
    expect(imgs?.names).toEqual([
      'OEBPS/images/fig2.png',
      'OEBPS/images/fig10.png',
      'OEBPS/top.jpg',
    ]);
  });

  it('EPUB 能按条目名取回原始字节', async () => {
    const imgs = await openBookImages(await makeMultiImageEpub(), 'epub');
    expect(await imgs!.read('OEBPS/top.jpg')).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('OPF 声明了但包里没有的条目不列出，直接读也返回 null', async () => {
    const imgs = await openBookImages(await makeMultiImageEpub(true), 'epub');
    expect(imgs?.names.some(n => n.includes('ghost'))).toBe(false);
    expect(await imgs!.read('OEBPS/images/ghost.png')).toBeNull();
  });

  it('漫画包列出全部页面，非图片条目被排除', async () => {
    const zip = new JSZip();
    zip.file('p10.jpg', Buffer.from([0x0a]));
    zip.file('p2.jpg', Buffer.from([0x02]));
    zip.file('readme.txt', 'x');
    const p = path.join(tmpDir, 'c.cbz');
    fs.writeFileSync(p, await zip.generateAsync({ type: 'nodebuffer' }));

    const imgs = await openBookImages(p, 'cbz');
    expect(imgs?.names).toEqual(['p2.jpg', 'p10.jpg']);
    expect(await imgs!.read('p2.jpg')).toEqual(Buffer.from([0x02]));
  });

  it('PDF 与 TXT 没有内嵌图片可取，返回 null', async () => {
    expect(await openBookImages(path.join(tmpDir, 'a.pdf'), 'pdf')).toBeNull();
    expect(await openBookImages(path.join(tmpDir, 'a.txt'), 'txt')).toBeNull();
  });

  it('格式串带前导点也能识别', async () => {
    expect(await openBookImages(await makeMultiImageEpub(), '.epub')).not.toBeNull();
  });
});
