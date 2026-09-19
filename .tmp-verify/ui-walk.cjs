/**
 * 界面走查：真窗口 + 真渲染层，逐界面截图。
 *
 * 与 acceptance.js 的区别：
 *   acceptance.js 走 IPC 层（设 BOOKREADER_HEADLESS_ACCEPTANCE=1，不开窗口、不建托盘），
 *   验的是「通道返回对不对」；本脚本反过来——**故意不设该变量**，把真窗口拉起来，
 *   用 executeJavaScript 模拟用户点击，再 capturePage 存图，
 *   验的是「渲染出来长什么样、点了有没有反应」。两者互补，不替代。
 *
 * 用法：npx electron .tmp-verify/ui-walk.cjs
 * 产出：.tmp-verify/shots/*.png（截图）、.tmp-verify/ui-walk-report.json
 *
 * 沙箱：userData/temp 指向独立目录，因此不会与正在运行的 electron 实例撞单实例锁，
 *       也不会污染真实书库。每轮清空 userData 以复现「首次启动」。
 */
'use strict';

const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const WALK = path.join(FIXTURES, 'walk');
const SHOTS = path.join(__dirname, 'shots');
const SANDBOX = process.env.BOOKREADER_UIWALK_DIR || path.join(os.tmpdir(), 'book-reader-uiwalk');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 日志与结果收集 ----------
const steps = [];
const consoleErrors = [];
/** 被拦下来的 webContents.print 调用（产品代码一行没改，只在这里记一笔） */
const printCalls = [];
/** 崩溃恢复提示的原文。误报一条就是「用户白被吓一次」，所以要能按条数断言，不能只翻日志 */
const crashPrompts = [];
function log(s) {
  const line = `[walk] ${s}`;
  console.log(line);
  steps.push(line);
}
/** 单步容错：某一步炸了不能让整轮走查停摆，记下来继续往下走 */
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    log(`OK   ${name}${r ? ` — ${r}` : ''} (${Date.now() - t0}ms)`);
    return r;
  } catch (e) {
    log(`FAIL ${name} — ${e && e.message ? e.message : e}`);
    // 失败时也留一张图：只看错误文案常常判断不出「它当时卡在哪个画面」
    try {
      if (mainWin) await shot(mainWin, `FAIL-${name.replace(/[^\w一-龥-]/g, '_').slice(0, 36)}`);
    } catch { /* 截图本身失败就算了 */ }
    return null;
  }
}

// ---------- 素材生成 ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 手搓纯色 PNG（不引第三方图像库，只借 zlib 压 IDAT） */
function solidPng(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const MD_SOURCE = `# 走查用文档

## 一、排版基线

这一段用来核对正文的行高、字距与段间距。中文排版最容易出问题的是**中西文混排**时的间距，
以及斜体 *emphasis*、粗体 **strong**、行内代码 \`const x = 1\` 三者在同一行里的基线是否对齐。

### 1.1 列表

- 无序项甲
- 无序项乙
  - 嵌套项乙一
  - 嵌套项乙二

1. 有序项一
2. 有序项二

- [ ] 未完成任务
- [x] 已完成任务

### 1.2 引用与代码

> 引用块第一行。
> 引用块第二行，用来核对左边框与内边距。

\`\`\`ts
/**
 * 代码块：核对等宽字体、横向滚动，以及长行会不会把整个页面撑宽。
 */
export function wrapDocRanges(doc: Document, block: HTMLElement, ranges: { s: number; e: number; id?: number }[]) {
  // 这一行故意写得非常长非常长非常长非常长非常长非常长非常长，用来验证代码块不撑破容器
  return ranges.slice().sort((a, b) => b.s - a.s);
}
\`\`\`

### 1.3 表格

| 列一 | 列二 | 列三 |
| --- | --- | --- |
| 甲 | 乙 | 丙 |
| 数值 100 | 数值 200 | 一个很长很长的单元格内容，用来测试换行 |

---

## 二、批注落点

这一节用来验证「块内文本偏移 → 文本节点」的换算：把下面整句选中加批注，看高亮套得准不准。

从前有座山，山里有座庙，庙里有个老和尚。前面**重点**后面，行内标签两侧也不该错位。

## 三、公式

行内公式 $E = mc^2$，以及独立成行的公式。

## 四、链接与标签

一条[普通链接](https://example.com) 与一条 [[双链引用]]。标签 #走查 #排版。

## 五、图片

![走查占位图](walk-img.png)
`;

const DOCX_PARAS = [
  ['Heading1', 'DOCX 走查文档'],
  ['Normal', '这一段用来核对 DOCX 转 HTML 之后的正文样式：行高、段间距、首行是否缩进。'],
  ['Heading2', '一、行内样式'],
  ['Normal', '这一行里有 {b}粗体{/b}、{i}斜体{/i}与等宽片段，用来核对行内标签是否被完整保留。'],
  ['Heading2', '二、列表与表格'],
  ['Normal', '列表在 DOCX 里是 numPr，转出来应当是 ol 或 ul 元素（此处刻意不写尖括号，否则会成为未转义的 XML 标签）。'],
  ['Heading2', '三、图片'],
  ['Normal', '下面这张图用来验证 mammoth 把内联图片转成 data: URL 之后，阅读器是否真的能渲染出来。'],
];

function docxParagraph(text, style) {
  const pStyle = style && style !== 'Normal' ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  // 极简标记：{b}..{/b} 粗体、{i}..{/i} 斜体，其余当纯文本
  const runs = [];
  const re = /\{(\/?)([bi])\}/g;
  let cursor = 0;
  let bold = false;
  let italic = false;
  const pushText = t => {
    if (!t) return;
    const rPr = bold || italic
      ? `<w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}</w:rPr>`
      : '';
    runs.push(`<w:r>${rPr}<w:t xml:space="preserve">${t}</w:t></w:r>`);
  };
  let m;
  while ((m = re.exec(text))) {
    pushText(text.slice(cursor, m.index));
    const on = m[1] !== '/';
    if (m[2] === 'b') bold = on; else italic = on;
    cursor = m.index + m[0].length;
  }
  pushText(text.slice(cursor));
  return `<w:p>${pStyle}${runs.join('')}</w:p>`;
}

function docxTable(rows) {
  const tr = rows.map(cells => `<w:tr>${cells.map(c =>
    `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${docxParagraph(c, 'Normal')}</w:tc>`).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>`
    + `<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>`
    + tr + '</w:tbl>' + docxParagraph('表格之后的一段正文，用来核对表格的上下间距。', 'Normal');
}

function docxImage(rId, emu) {
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${emu}" cy="${emu}"/><wp:docPr id="1" name="Picture 1"/>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>`
    + `<pic:nvPicPr><pic:cNvPr id="0" name="walk.png"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu}" cy="${emu}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

async function makeDocx(dest) {
  const JSZip = require('jszip');
  const zip = new JSZip();

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/walk.png"/>
</Relationships>`);

  const styleDef = (id, name, size, outline) => `<w:style w:type="paragraph" w:styleId="${id}">`
    + `<w:name w:val="${name}"/><w:basedOn w:val="Normal"/>`
    + `<w:pPr><w:outlineLvl w:val="${outline}"/><w:spacing w:before="240" w:after="120"/></w:pPr>`
    + `<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>
${styleDef('Heading1', 'heading 1', 36, 0)}
${styleDef('Heading2', 'heading 2', 30, 1)}
</w:styles>`);

  const body = [
    docxParagraph(DOCX_PARAS[0][1], 'Heading1'),
    docxParagraph(DOCX_PARAS[1][1], 'Normal'),
    docxParagraph(DOCX_PARAS[2][1], 'Heading2'),
    docxParagraph(DOCX_PARAS[3][1], 'Normal'),
    docxTable([['列一', '列二', '列三'], ['甲', '乙', '丙'], ['数值 100', '数值 200', '一个很长很长的单元格内容，用来测试换行']]),
    docxParagraph(DOCX_PARAS[4][1], 'Heading2'),
    docxParagraph(DOCX_PARAS[5][1], 'Normal'),
    docxParagraph('1. 有序项一\n2. 有序项二', 'Normal'),
    docxParagraph(DOCX_PARAS[6][1], 'Heading2'),
    docxParagraph(DOCX_PARAS[7][1], 'Normal'),
    docxImage('rId10', 1828800), // 2 英寸 = 1828800 EMU
  ].join('');

  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>
</w:document>`);

  zip.file('word/media/walk.png', solidPng(64, 64, [70, 120, 200]));

  fs.writeFileSync(dest, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function makePdf(dest) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle('PDF 走查文档');
  doc.setAuthor('ui-walk');
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // 正文行数要够多，重排后才会跨屏——PDF 检索的跳转在两种版式下坐标系不同，
  // 只出一屏的话「跨屏跳转」那条分支根本走不到（第一版素材就吃了这个亏）。
  const filler = (n, tag) =>
    Array.from({ length: n }, (_, i) =>
      `${tag} filler line ${i + 1}: plain body text so the page has something to scroll and reflow.`);

  const pages = [
    ['Chapter One: Rendering Baseline', [
      'This page exists to check the PDF rendering pipeline end to end.',
      'The text below is a real text layer, so selection and search can be exercised.',
      'Line spacing, margins and the fit mode are what to look at first.',
    ]],
    ['Chapter Two: Text Layer', [
      'A searchable phrase lives on this page: needle-in-haystack.',
      'Selecting this paragraph should raise the selection toolbar.',
      'Copy should put the selected text on the clipboard.',
    ]],
    ['Chapter Three: Long Page', filler(24, 'Third page')],
    ['Chapter Four: Reflow Depth', filler(26, 'Fourth page')],
    ['Chapter Five: Deep Target', [
      'The deep target phrase sits on the fifth page: needle-deep.',
      ...filler(22, 'Fifth page'),
    ]],
  ];

  pages.forEach(([title, lines], i) => {
    const page = doc.addPage([595, 842]); // A4
    page.drawText(title, { x: 60, y: 760, size: 20, font, color: rgb(0.1, 0.1, 0.2) });
    lines.forEach((ln, j) => {
      page.drawText(ln, { x: 60, y: 720 - j * 22, size: 11, font, color: rgb(0.2, 0.2, 0.2) });
    });
    page.drawText(`- ${i + 1} -`, { x: 285, y: 40, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  });

  fs.writeFileSync(dest, await doc.save());
}

/**
 * 漫画素材：页面要明显高于窗口，容器才真的有可滚动的量。
 * 现有 sample.cbz 是 160×90 的小图，撑不出溢出，拖动平移在它上面等于没验。
 */
async function makeTallCbz(dest) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  for (let i = 1; i <= 3; i++) {
    zip.file(`page-${String(i).padStart(3, '0')}.png`, solidPng(520, 1500, [30 + i * 45, 70, 110]));
  }
  fs.writeFileSync(dest, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function ensureFixtures() {
  fs.mkdirSync(WALK, { recursive: true });
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  fs.writeFileSync(path.join(WALK, 'walkmarkdown.md'), MD_SOURCE);
  // Markdown 里的相对图片：阅读器按 /local-file 协议解析，同目录即可
  const img = solidPng(160, 90, [200, 90, 70]);
  fs.writeFileSync(path.join(WALK, 'walk-img.png'), img);
  fs.writeFileSync(path.join(WALK, 'walk-img.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#c85a46"/><text x="16" y="68" font-size="20" fill="#fff">走查占位图</text></svg>`);
  await makeDocx(path.join(WALK, 'walkdocument.docx'));
  await makePdf(path.join(WALK, 'walkpdf.pdf'));
  await makeTallCbz(path.join(WALK, 'walktall.cbz'));

  return [
    path.join(WALK, 'walkmarkdown.md'),
    path.join(WALK, 'walkdocument.docx'),
    path.join(WALK, 'walkpdf.pdf'),
    path.join(WALK, 'walktall.cbz'),
    path.join(FIXTURES, 'sample.epub'),
    path.join(FIXTURES, 'sample.txt'),
    path.join(FIXTURES, 'sample.cbz'),
  ];
}

// ---------- 沙箱：必须在 require 主进程之前设好 ----------
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, 'userData'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, 'temp'), { recursive: true });
app.setPath('userData', path.join(SANDBOX, 'userData'));
app.setPath('temp', path.join(SANDBOX, 'temp'));
// 注意：这里**不设** BOOKREADER_HEADLESS_ACCEPTANCE —— 走查要的就是真窗口。

// ---------- 渲染层驱动助手 ----------
let mainWin = null;
const extraWins = [];

app.on('browser-window-created', (_e, win) => {
  if (!mainWin) {
    mainWin = win;
  } else if (!extraWins.includes(win)) {
    extraWins.push(win);
  }
  win.webContents.on('console-message', (_ev, level, message) => {
    // level 3 = error（Electron 34 起是字符串，这里两种都兜住）
    // 上限放到 1200：下面注入的探针会把错误栈一起打进来，400 字符会把栈截掉
    if (level === 3 || level === 'error') {
      consoleErrors.push(message.slice(0, 1200));
      // 顺手按发生顺序记一行：末尾只汇总条数，对不上是哪一步出的（同一句话出现多次时
      // 尤其看不出来），有了这行就能跟走查步骤对齐
      log(`!! 控制台错误（第 ${consoleErrors.length} 条）：${String(message).split('\n')[0].slice(0, 160)}`);
    }
  });
  // 诊断埋点：渲染层的未捕获异常与未处理的 Promise 拒绝默认只报一行消息、不带栈，
  // 定位不了来源。这里在页面里补一层监听，把 error.stack 一并打进控制台，
  // 走查的 console-message 钩子会连栈一起收走。
  win.webContents.on('did-finish-load', () => {
    win.webContents
      .executeJavaScript(
        `(() => {
          if (window.__stackProbe) return 'skip';
          window.__stackProbe = true;
          const dump = (tag, e) => {
            const s = (e && (e.stack || e.message)) || String(e);
            console.error('[probe] ' + tag + ' :: ' + s);
          };
          window.addEventListener('error', ev => dump('onerror', ev.error || ev.message));
          window.addEventListener('unhandledrejection', ev => dump('unhandledrejection', ev.reason));
          return 'ok';
        })()`,
        true,
      )
      .catch(() => {});
  });
  win.webContents.on('render-process-gone', (_ev, d) => log(`!! 渲染进程崩了: ${JSON.stringify(d)}`));
  win.webContents.on('unresponsive', () => log('!! 窗口无响应'));
  // 打印会把系统模态对话框拉起来，走查点不了它（点了整轮就卡死）。
  // 这里只把调用本身拦下来记录：验的是「应用确实发起了打印、打的是内容窗口、参数是什么」，
  // 真去调打印机不是走查该干的事。
  try {
    win.webContents.print = (opts, cb) => {
      printCalls.push({ url: win.webContents.getURL(), opts: opts || {} });
      if (typeof cb === 'function') setTimeout(() => cb(true, ''), 200);
      return true;
    };
  } catch (e) {
    log(`!! 打印拦截器没装上：${e && e.message ? e.message : e}`);
  }
});

const js = (win, code) => win.webContents.executeJavaScript(code, true);

/** 点击选择器；命中返回 OK，未命中返回 MISS 串（不抛错，让走查继续） */
async function click(win, sel, nth = 0) {
  const r = await js(win, `(() => {
    const els = document.querySelectorAll(${JSON.stringify(sel)});
    if (!els[${nth}]) return 'MISS';
    els[${nth}].click();
    return 'OK';
  })()`);
  if (r !== 'OK') throw new Error(`点不到 ${sel}[${nth}]`);
  return r;
}

/** 按可见文本点击（按钮文案会变，选择器不一定稳） */
async function clickText(win, sel, text, exact = false) {
  const r = await js(win, `(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const t = ${JSON.stringify(text)};
    const hit = els.find(e => ${exact ? 'e.textContent.trim() === t' : 'e.textContent.includes(t)'});
    if (!hit) return 'MISS:' + els.map(e => e.textContent.trim().slice(0, 20)).join('/');
    hit.click();
    return 'OK';
  })()`);
  if (r !== 'OK') throw new Error(`文本「${text}」点不到：${r}`);
  return r;
}

async function waitFor(win, sel, timeout = 20000, desc) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await js(win, `!!document.querySelector(${JSON.stringify(sel)})`)) return true;
    await sleep(200);
  }
  throw new Error(`等不到 ${desc || sel}（${timeout}ms）`);
}

async function count(win, sel) {
  return js(win, `document.querySelectorAll(${JSON.stringify(sel)}).length`);
}

let shotSeq = 0;
async function shot(win, name) {
  shotSeq += 1;
  const base = `${String(shotSeq).padStart(2, '0')}-${name}`;
  const file = path.join(SHOTS, `${base}.png`);
  // 内容指纹：截图取名容易错位，但这段文本能确凿说明「这一屏到底有没有内容、是什么内容」
  const fp = await js(win, `(() => {
    const el = document.querySelector('.main-content, .content, main') || document.body;
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    return { chars: t.length, head: t.slice(0, 100) };
  })()`).catch(() => ({ chars: -1, head: 'N/A' }));
  // 窗口可能还没真正上屏，capturePage 会拿到 0x0，重试几次
  let img = null;
  for (let i = 0; i < 16; i++) {
    img = await win.webContents.capturePage();
    const s = img.getSize();
    if (s.width > 0 && s.height > 0) break;
    await sleep(500);
  }
  const png = img.toPNG();
  fs.writeFileSync(file, png);
  const size = img.getSize();
  log(`  截图 ${base}.png (${size.width}x${size.height}, ${(png.length / 1024).toFixed(0)}KB) 内容 ${fp.chars} 字｜${fp.head}`);
  return file;
}

/** 逐段滚动截图：长页面一次截不全，按视口高度滚 N 屏 */
async function shotScroll(win, name, n = 3) {
  const out = [];
  await js(win, `(() => { const el = document.querySelector('.main-content, .content, main') || document.scrollingElement; if (el) el.scrollTop = 0; })()`);
  await sleep(300);
  for (let i = 0; i < n; i++) {
    out.push(await shot(win, `${name}${i === 0 ? '' : `-${i + 1}`}`));
    const moved = await js(win, `(() => {
      const el = document.querySelector('.main-content, .content, main');
      const target = el || document.scrollingElement;
      const before = target.scrollTop;
      target.scrollTop = before + (target.clientHeight || window.innerHeight) * 0.9;
      return target.scrollTop > before;
    })()`);
    await sleep(400);
    if (!moved) break;
  }
  return out;
}

/** 回到书架：点侧栏「书架」，并确保没有浮层挡着 */
async function goLibrary(win) {
  await js(win, `document.querySelectorAll('.modal-mask').forEach(m => { if (!m.classList.contains('onboarding-mask')) m.click(); })`);
  await sleep(200);
  await clickText(win, '.nav-item', '书架');
  await sleep(600);
}

/** 按书名关键词打开某本书的阅读器（书架卡片 → 详情页 → 开始阅读） */
async function openBook(win, keywords, exact = false) {
  await goLibrary(win);
  await waitFor(win, '.book-card');
  const titles = await js(win, `[...document.querySelectorAll('.book-card .book-title')].map(e => e.textContent.trim())`);
  const idx = titles.findIndex(t => keywords.some(k =>
    exact ? t === k : t.toLowerCase().includes(k.toLowerCase())));
  if (idx < 0) throw new Error(`书架上找不到 ${keywords.join('/')}，现有：${titles.join(' | ')}`);
  await click(win, '.book-card', idx);
  await waitFor(win, '.btn-primary.large', 10000, '详情页「开始阅读」');
  await sleep(400);
  await click(win, '.btn-primary.large');
  await sleep(1500);
  return titles[idx];
}

/**
 * 按卡片左上角的格式角标开书。
 * 比按书名稳：DOCX 在没有 core.xml 时会用首章节名当书名（本次走查里成了「三、图片」），
 * 这个名字不可预期，按格式选才不会因为素材换了就断。
 */
async function openBookByFormat(win, fmt, fallbackKeywords = []) {
  await goLibrary(win);
  await waitFor(win, '.book-card');
  const cards = await js(win, `[...document.querySelectorAll('.book-card')].map(c => ({
    t: (c.querySelector('.book-title') || {}).textContent?.trim() || '',
    f: ((c.querySelector('.cover-foot') || {}).textContent || '').trim().toUpperCase(),
  }))`);
  let idx = cards.findIndex(x => x.f === fmt.toUpperCase());
  if (idx < 0 && fallbackKeywords.length) {
    idx = cards.findIndex(x => fallbackKeywords.some(k => x.t.toLowerCase().includes(k.toLowerCase())));
  }
  if (idx < 0) throw new Error(`书架上找不到 ${fmt} 格式的书，现有：${cards.map(x => `${x.t}[${x.f}]`).join(' | ')}`);
  await click(win, '.book-card', idx);
  await waitFor(win, '.btn-primary.large', 10000, '详情页「开始阅读」');
  await sleep(400);
  await click(win, '.btn-primary.large');
  await sleep(1500);
  return `${cards[idx].t}[${cards[idx].f}]`;
}

/** 在已打开的检索面板里输入关键词并回车，返回面板自报的状态 */
async function searchInBook(win, kw) {
  await js(win, `(() => {
    // 页面里同时有侧栏的「搜索书籍...」和检索面板的「输入关键词...」，要挑对那只
    const inp = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('关键词'));
    if (!inp) return;
    inp.focus();
    // React 受控输入必须走原生 setter，否则 onChange 收不到
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, ${JSON.stringify(kw)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
  })()`);
  await sleep(2500);
  return JSON.parse(await js(win, `(() => {
    const panel = document.querySelector('.toc-panel');
    return JSON.stringify({
      hitItems: document.querySelectorAll('.mark-item.search-hit').length,
      count: ((document.querySelector('.search-count') || {}).textContent || '').trim(),
      empty: ((document.querySelector('.empty-text') || {}).textContent || '').trim(),
      first: ((document.querySelector('.mark-item.search-hit') || {}).innerText || '').replace(/\\s+/g, ' ').slice(0, 50),
      panelHead: (panel ? panel.innerText : '').replace(/\\s+/g, ' ').slice(0, 100),
    });
  })()`));
}

/** 读页码指示器；原始版式是「页/总页」，重排视图是「屏/总屏」 */
const pageIndicator = (win) =>
  js(win, `(() => { const el = document.querySelector('.page-indicator'); return el ? el.textContent.trim() : 'N/A'; })()`);

/** 点检索结果的第一条 */
const clickFirstHit = (win) =>
  js(win, `(() => { const el = document.querySelector('.mark-item.search-hit'); if (el) el.click(); })()`);

/** 先把指针挪到别处再移进目标容器，读它此刻的计算光标（enter 只在跨边界时触发） */
async function cursorIn(win, sel) {
  const p = await js(win, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 80)) };
  })()`);
  if (!p) return 'MISS';
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 });
  await sleep(150);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
  await sleep(400);
  return js(win, `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).cursor`);
}

/**
 * 在某个滚动容器上按住左键真拖一段，返回拖动前后的滚动量。
 * 走的是 OS 级输入注入，所以指针捕获、React 事件这些真实链路都会被走到；
 * 直接改 el.scrollTop 是测不出东西的——那等于把被测代码绕过去了。
 */
async function dragPan(win, sel, dx, dy) {
  const before = await js(win, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      scrollTop: el.scrollTop, scrollLeft: el.scrollLeft,
      scrollH: el.scrollHeight, clientH: el.clientHeight,
      scrollable: el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth,
    };
  })()`);
  if (!before) throw new Error(`找不到容器 ${sel}`);

  win.webContents.sendInputEvent({ type: 'mouseDown', x: before.x, y: before.y, button: 'left', clickCount: 1 });
  // 分步走：一步到位的位移不构成拖动，也容易被合成事件丢掉
  const N = 6;
  for (let i = 1; i <= N; i++) {
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(before.x + (dx * i) / N),
      y: Math.round(before.y + (dy * i) / N),
    });
    await sleep(40);
  }
  win.webContents.sendInputEvent({
    type: 'mouseUp', x: Math.round(before.x + dx), y: Math.round(before.y + dy), button: 'left', clickCount: 1,
  });
  await sleep(300);

  const after = await js(win, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    return { scrollTop: el.scrollTop, scrollLeft: el.scrollLeft };
  })()`);
  return { ...before, after };
}

// ---------- 主流程 ----------
async function run() {
  const books = await ensureFixtures();
  log(`素材：${books.map(b => path.basename(b)).join(', ')}`);

  // 等主进程把窗口建起来（main.js 的 whenReady 回调里有 await DatabaseService.create()）
  const t0 = Date.now();
  while (!mainWin && Date.now() - t0 < 30000) await sleep(200);
  if (!mainWin) throw new Error('30s 内没等到主窗口');
  const win = mainWin;
  log('主窗口已创建');

  // 统一尺寸，保证截图可比
  win.setSize(1440, 900);
  win.setPosition(60, 60);
  if (win.isMinimized()) win.restore();

  // 打桩文件对话框（同 acceptance.js：替换 dialog 对象自身的方法才有效）
  let openQueue = [];
  let saveTarget = null; // 需要落盘的步骤（如导出正文）自行赋值，否则一律按「用户取消」处理
  const ee = require('electron');
  ee.dialog.showOpenDialog = async () => {
    const next = openQueue.length ? openQueue.shift() : null;
    // 每一项既可以是路径数组，也可以是 () => 路径数组。批量导出必须用函数形式：
    // 它要的是「一个目录」，而数组形式在桩里被当成「一个文件」——曾经因此拿到过
    // 'D:\桌面\book-reader\C'（'C:\Users\…' 被反斜杠转义后截断），readdirSync 直接 ENOENT。
    const paths = typeof next === 'function' ? next() : next;
    const ret = paths ? { canceled: false, filePaths: paths } : { canceled: true, filePaths: [] };
    log(`  [dialog] showOpenDialog → ${ret.canceled ? 'CANCELED' : ret.filePaths.length + ' 个文件'}`);
    return ret;
  };
  ee.dialog.showSaveDialog = async () => saveTarget
    ? { canceled: false, filePath: saveTarget }
    : { canceled: true, filePath: undefined };
  ee.dialog.showMessageBox = async (_w, opts) => {
    const b = (opts && opts.buttons) || ['确定'];
    log(`  [dialog] showMessageBox「${opts && opts.message}」→ ${b[0]}`);
    if (opts && /上次没有正常退出/.test(String(opts.message || ''))) crashPrompts.push(String(opts.message));
    return { response: 0, checkboxChecked: false };
  };
  ee.dialog.showErrorBox = (t, c) => log(`  [dialog] showErrorBox ${t}: ${c}`);

  if (win.webContents.isLoading()) {
    await new Promise(r => win.webContents.once('did-finish-load', r));
  }
  await sleep(2000); // React 挂载 + 首屏取数

  // ========== A. 首次启动 ==========
  // 引导页的门在 App.tsx: renderer 挂载后调 getSetting('onboarded')，返回非 '1' 才弹。
  // 那条 .then 没有 catch 之外的处理，取不到值时是静默不弹、没有任何现象可看，
  // 所以失败时把「通道到底返回了什么」一起带出来，否则只能猜。
  const onboardingProbe = `(async () => {
    let setting;
    try {
      const v = await window.electronAPI.getSetting('onboarded');
      setting = 'ok:' + JSON.stringify(v);
    } catch (e) { setting = 'reject:' + ((e && e.message) || String(e)); }
    return JSON.stringify({
      setting,
      eapi: typeof window.electronAPI,
      hasOnboarding: !!document.querySelector('.onboarding'),
    });
  })()`;

  await step('A1 首启引导页', async () => {
    try {
      await waitFor(win, '.onboarding', 15000, '首启引导');
    } catch (err) {
      throw new Error(`${err.message}｜诊断 ${await js(win, onboardingProbe)}`);
    }
    await shot(win, 'onboarding');
    const heads = await js(win, `[...document.querySelectorAll('.onboarding-card')].length`);
    return `${heads} 张说明卡`;
  });

  await step('A1b 关闭引导 → 书架空态', async () => {
    await clickText(win, '.onboarding-actions button', '跳过', true).catch(() => click(win, '.onboarding-actions .btn-secondary'));
    await sleep(800);
    await shot(win, 'library-empty');
  });

  // ========== B. 书架 ==========
  await step('B1 导入 7 本书（走真实「导入书籍」按钮 + 打桩对话框）', async () => {
    openQueue.push(books);
    await click(win, '.import-btn');
    // 导入是逐个处理：EPUB 要解析、封面要生成，给足时间并轮询
    const t = Date.now();
    let n = 0;
    while (Date.now() - t < 90000) {
      n = await count(win, '.book-card');
      if (n >= books.length) break;
      await sleep(500);
    }
    await sleep(1200);
    return `书架现有 ${n} 本（期望 ${books.length}）`;
  });

  await step('B2 书架网格态', async () => shot(win, 'library-grid'));
  await step('B2b 书架列表态', async () => {
    await click(win, '.view-switch button', 1).catch(() => click(win, '[title*="列表"]'));
    await sleep(600);
    await shot(win, 'library-list');
    await click(win, '.view-switch button', 0).catch(() => click(win, '[title*="网格"]'));
    await sleep(500);
  });

  await step('B3 卡片右键菜单', async () => {
    const box = await js(win, `(() => {
      const c = document.querySelector('.book-card');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    // 用 sendInputEvent 从输入层注入真实右键（dispatchEvent 出来的合成 contextmenu 有时收不到）
    win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'right', clickCount: 1 });
    await sleep(1000);
    const items = await js(win, `[...document.querySelectorAll('.context-menu-item')].map(e => e.textContent.trim())`);
    await shot(win, 'library-contextmenu');
    await js(win, `document.querySelector('.context-menu-mask')?.click(); document.body.click();`);
    await sleep(500);
    return `菜单项 ${items.length} 条：${items.slice(0, 4).join('/')}…`;
  });

  // ========== C. 详情页 ==========
  await step('C1 打开详情页', async () => {
    await click(win, '.book-card', 0);
    await waitFor(win, '.btn-primary.large', 10000, '详情页');
    await sleep(800);
    await shot(win, 'detail-page');
  });

  await step('C2 详情页各标签', async () => {
    const tabs = await js(win, `[...document.querySelectorAll('.tab, .detail-tab')].map(e => e.textContent.trim())`);
    const out = [`标签：${tabs.join('/')}`];
    for (let i = 0; i < tabs.length; i++) {
      await click(win, '.tab, .detail-tab', i);
      await sleep(700);
      await shot(win, `detail-tab-${i}-${tabs[i]}`);
    }
    return out.join('，');
  });

  // ========== D. 阅读器 ==========
  await step('D1 MARKDOWN 阅读器（批 4 重点）', async () => {
    const title = await openBookByFormat(win, 'MD', ['走查用文档']);
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await sleep(2500);
    await shot(win, 'reader-md');
    const marks = await js(win, `({
      h1: document.querySelectorAll('.doc-body h1, .reader h1').length,
      table: document.querySelectorAll('.doc-body table, .reader table').length,
      img: document.querySelectorAll('.doc-body img, .reader img').length,
      code: document.querySelectorAll('.doc-body pre, .reader pre').length,
    })`);
    return `${title} — h1:${marks.h1} 表:${marks.table} 图:${marks.img} 代码块:${marks.code}`;
  });

  await step('D2 滚动看排版下半段', async () => {
    await js(win, `(() => { const el = document.querySelector('.doc-body, .reader-content, .reader-scroll'); if (el) el.scrollTop = el.scrollHeight * 0.45; })()`);
    await sleep(800);
    await shot(win, 'reader-md-scrolled');
  });

  await step('D3 目录面板', async () => {
    await click(win, '[title="目录"]');
    await sleep(1200);
    const n = await js(win, `document.querySelectorAll('.toc-item, .toc-list li, .toc-panel li').length`);
    await shot(win, 'reader-panel-toc');
    return `目录项 ${n} 条`;
  });

  await step('D4 排版设置面板', async () => {
    await click(win, '[title="排版自定义"]');
    await sleep(1200);
    await shot(win, 'reader-panel-typography');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(600);
  });

  await step('D5 选中文字出划词菜单（真实鼠标拖选）', async () => {
    // 重开一次这本书：上一步的面板操作可能把视图带走了，从干净状态起算最可靠
    await openBook(win, ['走查用文档']);
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await sleep(2000);
    const box = await js(win, `(() => {
      const els = [...document.querySelectorAll('p')];
      const el = els.find(e => e.textContent.includes('从前有座山'));
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
    })()`);
    if (!box) throw new Error('正文里找不到「从前有座山」那段');
    await sleep(600);

    // 手法一：直接建立选区，**不补发任何鼠标事件**。
    // selectionchange 由浏览器自己发；手动补 mouseup 反而可能命中应用
    // 「点击空白处取消划词条」的逻辑，把刚建立的选区清掉（这是第 1 轮的失败原因）。
    await js(win, `(() => {
      const el = [...document.querySelectorAll('p')].find(e => e.textContent.includes('从前有座山'));
      if (!el) return 'NOP';
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return 'SEL';
    })()`);
    await sleep(1800);
    let sel = await js(win, `(window.getSelection() || {}).toString().slice(0, 30)`);
    let popup = await js(win, `!!document.querySelector('.select-popup')`);
    const firstTry = `建选区后：选中「${sel}」，划词菜单${popup ? '已出现' : '未出现'}`;

    // 手法二：真实鼠标拖选（OS 级输入注入）
    if (!popup) {
      await js(win, `window.getSelection().removeAllRanges()`);
      await sleep(300);
      const x2 = box.x + Math.min(box.w - 12, 320);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(60);
      for (let i = 1; i <= 8; i++) {
        win.webContents.sendInputEvent({
          type: 'mouseMove', x: Math.round(box.x + (x2 - box.x) * i / 8), y: box.y, button: 'left',
        });
        await sleep(40);
      }
      win.webContents.sendInputEvent({ type: 'mouseUp', x: x2, y: box.y, button: 'left', clickCount: 1 });
      await sleep(1500);
      sel = await js(win, `(window.getSelection() || {}).toString().slice(0, 30)`);
      popup = await js(win, `!!document.querySelector('.select-popup')`);
    }
    await shot(win, 'reader-selection-menu');
    return `${firstTry}｜拖选后：选中「${sel}」，划词菜单${popup ? '已出现' : '未出现'}`;
  });

  await step('D6 DOCX 阅读器（批 5 重点）', async () => {
    const title = await openBookByFormat(win, 'DOCX', ['三、图片', 'walkdocument']);
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await sleep(2500);
    await shot(win, 'reader-docx');
    const marks = await js(win, `({
      h: document.querySelectorAll('.doc-body h1, .doc-body h2, .reader h1, .reader h2').length,
      table: document.querySelectorAll('.doc-body table, .reader table').length,
      img: document.querySelectorAll('.doc-body img, .reader img').length,
      imgSrc: (document.querySelector('.doc-body img, .reader img') || {}).src?.slice(0, 30) || 'NONE',
    })`);
    return `${title} — 标题:${marks.h} 表:${marks.table} 图:${marks.img} 图源:${marks.imgSrc}`;
  });

  await step('D7 EPUB 阅读器', async () => {
    const title = await openBookByFormat(win, 'EPUB');
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await sleep(2500);
    await shot(win, 'reader-epub');
    return title;
  });

  await step('D8 TXT 阅读器', async () => {
    const title = await openBookByFormat(win, 'TXT');
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await sleep(2500);
    await shot(win, 'reader-txt');
    return title;
  });

  await step('D9 PDF 阅读器', async () => {
    const title = await openBookByFormat(win, 'PDF');
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await sleep(3000);
    await shot(win, 'reader-pdf');
    return title;
  });

  await step('D10 PDF 缩略图侧栏', async () => {
    await click(win, '[title="页面缩略图"]');
    // 缩略图是「滚动到哪生成到哪」，给足时间让第 1 页画出来
    await sleep(4000);
    const stat = await js(win, `({
      list: !!document.querySelector('.thumb-list'),
      ph: document.querySelectorAll('.thumb-ph').length,
      no: document.querySelectorAll('.thumb-no').length,
      img: document.querySelectorAll('.thumb-list img, .thumb-ph img, .thumb-list canvas').length,
    })`);
    await shot(win, 'reader-pdf-thumbs');
    await js(win, `document.querySelector('.context-menu-mask, .panel-mask')?.click()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(600);
    return `缩略图列表${stat.list ? '已开' : '未开'}，占位 ${stat.ph}，空态 ${stat.no}，已出图 ${stat.img}`;
  });

  await step('D11 漫画（CBZ）阅读器', async () => {
    const title = await openBookByFormat(win, 'CBZ', ['sample']);
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await sleep(2500);
    await shot(win, 'reader-cbz');
    return title;
  });

  // 书内检索：这是「PDF 书内检索」待办项的直接参照，先在 EPUB 上确认既有链路是否可用
  await step('D12 书内检索（EPUB）', async () => {
    await openBookByFormat(win, 'EPUB');
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await sleep(2500);
    await click(win, '[title="书内检索"]');
    await sleep(1200);
    // 先把搜索面板里的输入框情况记下来（有几只、placeholder 是什么），再决定往哪只里写字
    const inputs = await js(win, `[...document.querySelectorAll('input')].map(i => ({
      type: i.type, ph: i.placeholder || '', cls: String(i.className).slice(0, 40),
    }))`);
    // 搜索词必须是正文里确实存在的：sample.epub 各章正文是「第一章的正文内容…」等。
    // 注意选对输入框：页面里同时有侧栏的「搜索书籍...」与检索面板的「输入关键词...」，
    // 取第一个 text input 会写到侧栏那个去（上一轮 0 命中就是这么来的）。
    const found = await js(win, `(() => {
      const inp = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('关键词'))
        || document.querySelector('input[placeholder="输入关键词..."]');
      if (!inp) return 'NOINPUT';
      inp.focus();
      // React 受控输入必须走原生 setter，否则 onChange 收不到
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '正文');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      return 'OK:' + inp.value;
    })()`);
    await sleep(2500);
    // 若回车没触发，再找「搜」按钮点一下
    const hit1 = await js(win, `document.querySelectorAll('.mark-item.search-hit').length`);
    if (hit1 === 0) {
      await js(win, `(() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '搜' || x.textContent.trim() === '搜索');
        if (b) b.click();
      })()`);
      await sleep(2000);
    }
    const hits = await js(win, `(() => {
      // 命中列表 .search-hit 是渲染在主文档里的（不是 iframe），所以直接数它就够。
      // 同时把面板自己的结论也抄回来：「共找到 N 处」/「没有找到相关内容」能区分
      // 「搜了但没命中」和「搜索压根没跑起来」——只看元素数分不出这两者。
      const panel = document.querySelector('.toc-panel');
      const inp = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('关键词'));
      return JSON.stringify({
        inputValue: inp ? inp.value : 'NOINPUT',
        hitItems: document.querySelectorAll('.mark-item.search-hit').length,
        count: ((document.querySelector('.search-count') || {}).textContent || '').trim(),
        empty: ((document.querySelector('.empty-text') || {}).textContent || '').trim(),
        panelHead: (panel ? panel.innerText : '').replace(/\\s+/g, ' ').slice(0, 160),
      });
    })()`);
    await shot(win, 'reader-search-epub');
    return `输入框 ${found}，命中元素 ${hits}，面板内 input：${JSON.stringify(inputs)}`;
  });

  // 三档主题的观感差异（深色 / 浅色 / 护眼纸色）
  await step('D13 主题三档观感', async () => {
    const out = [];
    for (const [t, name] of [['浅色主题', 'light'], ['护眼纸色主题', 'sepia'], ['深色主题', 'dark']]) {
      await click(win, `[title="${t}"]`);
      await sleep(1400);
      await shot(win, `reader-theme-${name}`);
      out.push(t);
    }
    return out.join(' → ');
  });

  // PDF 文本层能不能真的抽出来——这是「PDF 书内检索」的前置：抽不出文字，接检索无从谈起。
  // 走「导出正文为 TXT」这条现成链路，比直接调 IPC 更接近用户实际路径。
  await step('D14 PDF 正文导出（验证文本层提取）', async () => {
    await goLibrary(win);
    await waitFor(win, '.book-card');
    const card = await js(win, `(() => {
      const cards = [...document.querySelectorAll('.book-card')];
      const c = cards.find(x => ((x.querySelector('.cover-foot') || {}).textContent || '').trim().toUpperCase() === 'PDF');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!card) throw new Error('书架上没有 PDF 卡片');

    // saveTarget 必须在触发导出「之前」就位：导出流程跑完抽文本就会调 showSaveDialog，
    // 打桩读的就是这个变量，晚一步赋值就只能拿到 canceled，表现为「文件没落地」。
    const outDir = path.join(SANDBOX, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    saveTarget = path.join(outDir, 'pdf-text.txt');
    fs.rmSync(saveTarget, { force: true });

    win.webContents.sendInputEvent({ type: 'mouseDown', x: card.x, y: card.y, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: card.x, y: card.y, button: 'right', clickCount: 1 });
    await sleep(1000);
    await clickText(win, '.context-menu-item', '导出正文为 TXT');

    // 导出是异步的：轮询等文件落地
    let size = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      if (fs.existsSync(saveTarget)) {
        size = fs.statSync(saveTarget).size;
        if (size > 0) break;
      }
      await sleep(500);
    }
    await sleep(800);
    await shot(win, 'pdf-export-text');
    if (!size) return '导出文件没落地或为空';
    const head = fs.readFileSync(saveTarget, 'utf8').replace(/\s+/g, ' ').slice(0, 80);
    return `导出 ${size} 字节，开头：${head}`;
  });

  // 导出为 EPUB：2026-09-18 新接的「抽章节 → buildEpub → 落盘」链路。
  // 只看文件落地不算验过——把包解回来确认 mimetype / OPF / NCX / 章节齐全，
  // 才算真的产出了一本 EPUB（渲染层与外部边界的缺陷正是这个项目栽过跟头的地方）。
  await step('D19 导出为 EPUB（抽章节 → 打包 → 回读校验）', async () => {
    await goLibrary(win);
    await waitFor(win, '.book-card');
    const card = await js(win, `(() => {
      const cards = [...document.querySelectorAll('.book-card')];
      const c = cards.find(x => ((x.querySelector('.cover-foot') || {}).textContent || '').trim().toUpperCase() === 'TXT');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!card) throw new Error('书架上没有 TXT 卡片');

    const outDir = path.join(SANDBOX, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    saveTarget = path.join(outDir, 'export.epub');
    fs.rmSync(saveTarget, { force: true });

    win.webContents.sendInputEvent({ type: 'mouseDown', x: card.x, y: card.y, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: card.x, y: card.y, button: 'right', clickCount: 1 });
    await sleep(1000);
    await clickText(win, '.context-menu-item', '导出为 EPUB');

    let size = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      if (fs.existsSync(saveTarget)) {
        size = fs.statSync(saveTarget).size;
        if (size > 0) break;
      }
      await sleep(500);
    }
    await sleep(800);
    await shot(win, 'export-epub');
    if (!size) return '导出文件没落地或为空';

    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(saveTarget));
    const names = Object.keys(zip.files);
    const need = ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/toc.ncx'];
    const missing = need.filter(n => !names.includes(n));
    if (missing.length) return `导出 ${size} 字节，但包内缺少：${missing.join(' / ')}`;

    const mimetype = (await zip.file('mimetype').async('string')).trim();
    if (mimetype !== 'application/epub+zip') return `mimetype 不对：${mimetype}`;

    const chapters = names.filter(n => /^OEBPS\/Text\/ch\d+\.xhtml$/.test(n));
    if (chapters.length === 0) return '包内没有任何章节文件';
    const first = await zip.file(chapters.sort()[0]).async('string');
    const bodyText = first.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${size} 字节，${chapters.length} 章，mimetype ✓；首章开头：${bodyText}`;
  });

  // 批量导出：新开的入口，验的是「目录只选一次」这条设计。
  // 若误用了上面两个单本 handler，每本都会各弹一次保存框，批量等于不可用——那时这里
  // 一个文件都不会落地（单本走 showSaveDialog，saveTarget 此刻为 null，一律按取消处理）。
  // 判完成只用主进程侧的 fs 轮询，不查渲染进程：批次跑完前端会弹 alert，渲染层有可能被
  // 那个模态挡住，这时 executeJavaScript 会挂住，反而等不到结果。
  await step('D20 批量导出 TXT（选一次目录 → 逐本落盘）', async () => {
    await goLibrary(win);
    await waitFor(win, '.book-card');
    if (await js(win, `!!document.querySelector('.batch-bar')`)) {
      await clickText(win, 'button', '退出批量', true); // 上一步可能把批量态留下来了
      await sleep(500);
    }
    const outDir = path.join(SANDBOX, 'batch-out');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    await clickText(win, 'button', '批量管理', true);
    await sleep(600);
    await clickText(win, 'button', '全选当前', true);
    await sleep(400);
    const picked = await js(win, `document.querySelectorAll('.book-card.selected').length`);
    if (!picked) throw new Error('全选后没有选中任何书');

    // 只放一项：批量本该只消费一次目录选择。必须用函数形式——写成数组会被桩当成
    // 「一个文件路径」，主进程拿到的是被反斜杠转义截断的半截路径，readdirSync 直接 ENOENT。
    openQueue = [() => [outDir]];
    await shot(win, 'batch-before-export');
    await clickText(win, 'button', '导出TXT', true);

    // 等到「有文件且数量连续三轮不再增长」为止。书架上混着漫画等导不出文字的格式会被
    // 跳过，所以不能拿 picked 当终点，只能等它停下来。
    const isTxt = n => n.endsWith('.txt');
    const tally = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter(isTxt).length : 0);
    let landed = 0;
    let stable = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const now = tally();
      stable = now > 0 && now === landed ? stable + 1 : 0;
      landed = now;
      if (landed >= picked || stable >= 3) break;
      await sleep(1000);
    }
    await sleep(800);
    await shot(win, 'batch-after-export');

    const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter(isTxt) : [];
    if (!files.length) return `选中 ${picked} 本，但一个 TXT 都没落盘`;
    const empty = files.filter(n => fs.statSync(path.join(outDir, n)).size === 0);
    if (empty.length) return `落盘 ${files.length} 个，其中 ${empty.length} 个是空文件`;
    return `选中 ${picked} 本 → 落盘 ${files.length} 个 TXT，均非空`;
  });

  // 批量提取内嵌图片：与 D20 同一套判完成方式（主进程侧 fs 轮询，不查渲染进程）。
  // 书架里能抽的原样就三类：EPUB 一本、漫画两本；TXT / PDF / 文档型都不支持，
  // 所以「跳过若干本」是预期结果，不能拿 picked 当成功数。
  await step('D21 批量提取内嵌图片（每本一个子目录）', async () => {
    await goLibrary(win);
    await waitFor(win, '.book-card');
    if (await js(win, `!!document.querySelector('.batch-bar')`)) {
      await clickText(win, 'button', '退出批量', true);
      await sleep(500);
    }
    const outDir = path.join(SANDBOX, 'batch-img-out');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    await clickText(win, 'button', '批量管理', true);
    await sleep(600);
    await clickText(win, 'button', '全选当前', true);
    await sleep(400);
    const picked = await js(win, `document.querySelectorAll('.book-card.selected').length`);
    if (!picked) throw new Error('全选后没有选中任何书');

    openQueue = [() => [outDir]];
    await shot(win, 'extract-before');
    await clickText(win, 'button', '提取图片', true);

    const tally = () => {
      let dirs = 0;
      let imgs = 0;
      for (const d of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) {
        const full = path.join(outDir, d);
        if (!fs.statSync(full).isDirectory()) continue;
        dirs++;
        imgs += fs.readdirSync(full).length;
      }
      return { dirs, imgs };
    };
    let last = { dirs: 0, imgs: 0 };
    let stable = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const now = tally();
      stable = now.imgs > 0 && now.imgs === last.imgs ? stable + 1 : 0;
      last = now;
      if (stable >= 3) break;
      await sleep(1000);
    }
    await sleep(800);
    await shot(win, 'extract-after');

    const { dirs, imgs } = tally();
    if (!dirs) return `选中 ${picked} 本，但没有生成任何书目录`;
    if (!imgs) return `生成了 ${dirs} 个目录，但一张图片都没有`;
    // 抽查一个书目录：里面必须全是非空图片（子目录里混进别的文件说明筛图没生效）
    const firstDir = fs.readdirSync(outDir).find(d => fs.statSync(path.join(outDir, d)).isDirectory());
    const files = fs.readdirSync(path.join(outDir, firstDir));
    const nonImage = files.filter(n => !/\.(jpe?g|png|gif|webp|bmp)$/i.test(n));
    const empty = files.filter(n => fs.statSync(path.join(outDir, firstDir, n)).size === 0);
    if (nonImage.length) return `「${firstDir}」里有非图片文件：${nonImage.slice(0, 3).join('、')}`;
    if (empty.length) return `「${firstDir}」里有空文件：${empty.slice(0, 3).join('、')}`;
    return `选中 ${picked} 本 → ${dirs} 个子目录 / ${imgs} 张图；抽查「${firstDir}」${files.length} 张全部非空`;
  });

  // PDF 原先连检索入口都没有（caps.text 一直把 PDF 挡在外面）。这两步验的是新开的那条路：
  // 搜得到、点得动、跳得准——两种版式的坐标系还不一样，得分别验。
  await step('D15 PDF 书内检索（原始版式）', async () => {
    await openBookByFormat(win, 'PDF');
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await sleep(3000);
    if (!(await js(win, `!!document.querySelector('[title="书内检索"]')`))) {
      return 'PDF 工具栏上没有「书内检索」入口';
    }
    await click(win, '[title="书内检索"]');
    await sleep(1200);
    // 搜一个只在第 5 页出现的词：命中页与「上次读到的位置」不同，
    // 页码变化才能证明是跳过去的结果，而不是本来就在那儿
    const state = await searchInBook(win, 'needle-deep');
    const before = await pageIndicator(win);
    await clickFirstHit(win);
    await sleep(2500);
    const after = await pageIndicator(win);
    await shot(win, 'pdf-search-original');
    return `命中 ${state.hitItems} 处（${state.count}），首条「${state.first}」，页码 ${before} → ${after}`;
  });

  await step('D16 PDF 书内检索（重排视图）', async () => {
    await click(win, '[title^="重排为流式排版"]');
    await sleep(8000); // 抽整本文字层再重排，慢
    if (!(await js(win, `!!document.querySelector('[data-reflow-block]')`))) {
      return '没能切到重排视图';
    }
    const total = await pageIndicator(win);
    await click(win, '[title="书内检索"]');
    await sleep(1200);

    // 第一搜：确认命中列表与标红。重排块是应用自己渲染的，能标红；
    // 标红要等跳转把检索词挂上才出现，所以得先点一条再看
    const chapters = await searchInBook(win, 'Chapter');
    await clickFirstHit(win);
    await sleep(2000);
    const marked = await js(win, `document.querySelectorAll('[data-reflow-block] mark.search-mark').length`);

    // 第二搜：换一个只在最后一页出现的词，逼出「跨屏跳转」——同屏内滚动不算数。
    // 注意点过命中后跳转会顺手把面板关掉，得先把它重新打开，否则这次搜索根本没跑
    await click(win, '[title="书内检索"]');
    await sleep(800);
    const deep = await searchInBook(win, 'needle-deep');
    const before = await pageIndicator(win);
    await clickFirstHit(win);
    await sleep(2500);
    const after = await pageIndicator(win);
    await shot(win, 'pdf-search-reflow');

    const num = (s) => Number(String(s).split('/')[0].trim());
    const moved = num(after) > num(before);
    return `共 ${total} 屏｜「Chapter」命中 ${chapters.hitItems} 处、标红 ${marked} 处｜`
      + `「needle-deep」命中 ${deep.hitItems} 处（${deep.count}），首条「${deep.first}」，`
      + `跳转 ${before} → ${after}${moved ? ' ✓ 跨屏' : '（未跨屏，需复核）'}`;
  });

  await step('D17 鼠标拖动页面（漫画固定版式）', async () => {
    // 这一屏的素材是 520×1500 的漫画页，比窗口高，容器里才有真可滚动的量
    const comic = await openBook(win, ['walktall']);
    // 锚点用 .comic-pane 而不是 .pan-surface：后者只在「指针已在容器内且容器此刻
    // 确有可滚动量」时才挂上，拿它当等待锚点会永远等不到
    await waitFor(win, '.comic-pane', 12000, '漫画固定版式容器');
    await sleep(2500);
    // 光标 = panReady 的外部表现：有得滚才该出现抓手
    const comicCursor = await cursorIn(win, '.comic-pane');
    // 往上拖（dy 为负）→ 内容上移 → scrollTop 变大
    const up = await dragPan(win, '.comic-pane', 0, -180);
    await shot(win, 'pan-comic');
    // 反向再拖，确认是双向平移而不是只能单向
    const down = await dragPan(win, '.comic-pane', 0, 120);

    // 对照组：文字类格式按住拖动必须仍是划词，不能变成平移，
    // 否则划词菜单、高亮、笔记这一整套都跟着废掉
    await openBookByFormat(win, 'TXT', ['txt', 'text']);
    await waitFor(win, '.txt-page', 10000, 'TXT 滚动区');
    await sleep(1500);
    const txt = await dragPan(win, '.txt-page', 0, -180);

    // 诊断：PDF 原始版式当前有没有可滚动的量。没有的话，这个面上挂拖拽就是死代码，
    // 而 grab 光标又构成「能拖」的假承诺，得先把事实测出来再决定去留
    await openBookByFormat(win, 'PDF');
    await waitFor(win, '.pdf-page', 10000, 'PDF 原始版式容器');
    await sleep(2500);
    const pdfGeo = JSON.parse(await js(win, `(() => {
      const el = document.querySelector('.pdf-page');
      const cv = el.querySelector('canvas');
      const r = cv.getBoundingClientRect();
      return JSON.stringify({
        ch: el.clientHeight, sh: el.scrollHeight,
        canvas: Math.round(r.width) + 'x' + Math.round(r.height),
        align: getComputedStyle(el).alignItems,
      });
    })()`));
    const pdf = await dragPan(win, '.pdf-page', 0, -200);
    await shot(win, 'pan-pdf-original');
    const pdfMoved = pdf.after.scrollTop - pdf.scrollTop;

    // 反例：把页面缩到装得下，那个面上就不该再挂抓手。
    // 点缩放按钮必须先让鼠标离开容器——这正好覆盖了 panReady 的重算路径：
    // 移出时清掉，移回时按当时的滚动量重判（这也是不挂 ResizeObserver 的前提）。
    // 档位不写死：pdfScale 是每本书记的、上一批步骤可能已经把它改过（实测这里是 1.9），
    // 所以只报「缩小 4 档之后量到的几何」，不声称缩到了某个具体倍数。
    const zoom = async (title, times) => {
      for (let i = 0; i < times; i++) {
        await js(win, `document.querySelector('button[title=${JSON.stringify(title)}]').click()`);
        await sleep(350);
      }
      await sleep(1200);
    };
    await zoom('缩小', 4);
    const fitCursor = await cursorIn(win, '.pdf-page');
    const fitRoom = JSON.parse(await js(win, `(() => {
      const el = document.querySelector('.pdf-page');
      return JSON.stringify({
        ch: el.clientHeight, sh: el.scrollHeight,
        scrollable: el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth,
      });
    })()`));
    await shot(win, 'pan-pdf-fit');
    // 还原到默认 1.5，别把 0.5 写进这本书的偏好留给后面
    await zoom('放大', 4);

    const geo = `漫画 ch=${up.clientH} sh=${up.scrollH}｜PDF ch=${pdfGeo.ch} sh=${pdfGeo.sh} canvas=${pdfGeo.canvas} align=${pdfGeo.align}`;
    const cursorGeo = `｜漫画 cursor=${comicCursor}、PDF 缩小 4 档后 ch=${fitRoom.ch} sh=${fitRoom.sh} cursor=${fitCursor}`;
    const moved = up.after.scrollTop - up.scrollTop;
    if (!up.scrollable) return `漫画容器没有可滚动量（scrollH=${up.scrollH} clientH=${up.clientH}），拖动验证不成立｜${geo}`;
    if (moved <= 0) return `漫画拖动后 scrollTop 没增加：${up.scrollTop} → ${up.after.scrollTop}（drag 未被接管）｜${geo}`;
    if (txt.after.scrollTop !== txt.scrollTop) return `文字类格式被误接管：.txt-page ${txt.scrollTop} → ${txt.after.scrollTop}｜${geo}`;
    if (!pdf.scrollable) return `漫画 OK（上拖 ${up.scrollTop}→${up.after.scrollTop}），但 PDF 原始版式无可滚动量｜${geo}`;
    if (pdfMoved <= 0) return `漫画 OK，但 PDF 拖动后 scrollTop 没增加：${pdf.scrollTop} → ${pdf.after.scrollTop}｜${geo}`;
    if (comicCursor !== 'grab') return `漫画有得滚却不出抓手光标（cursor=${comicCursor}），panReady 没挂上｜${geo}`;
    // 装得下时挂抓手 = 承诺一个拖不动的手势，这里必须不是 grab
    if (!fitRoom.scrollable && fitCursor === 'grab') return `PDF 缩小 4 档后已装得下（ch=${fitRoom.ch} sh=${fitRoom.sh}）仍是 grab 光标｜${geo}`;
    const fitPart = fitRoom.scrollable
      ? `PDF 缩小 4 档后仍可滚（ch=${fitRoom.ch} sh=${fitRoom.sh}），这条反例本次不成立`
      : `PDF 缩小 4 档后装得下（ch=${fitRoom.ch} sh=${fitRoom.sh}）光标回落 ${fitCursor} ✓ 无假承诺`;
    return `「${comic}」漫画 上拖 ${up.scrollTop}→${up.after.scrollTop}（+${moved}）、下拖 ${down.scrollTop}→${down.after.scrollTop}｜`
      + `PDF 原始版式 上拖 ${pdf.scrollTop}→${pdf.after.scrollTop}（+${pdfMoved}）｜`
      + `对照 TXT 拖动后 scrollTop 恒为 ${txt.scrollTop} ✓ 未抢划词｜${geo}${cursorGeo}｜${fitPart}`;
  });

  // ========== D18. 关闭当前文档 ==========
  // 回归点：原实现「只有一个标签时不套外壳」，于是关到剩一个时标签栏消失，
  // 最后一个标签再也没有关闭入口（P0「关闭文件」一直标 🟡 的根因）。
  // 现在标签栏常驻，并补了 Ctrl+W——键在主进程拦，因为 EPUB 正文渲染在 iframe 里，
  // 焦点落在正文上时渲染层的 window 监听收不到。
  await step('D18 关闭当前文档（单标签 × 与 Ctrl+W）', async () => {
    // 本步会反复挂载/卸载阅读器，单独记这一段产生的控制台错误：
    // 好把「单标签也套外壳」这条新路径的影响与其它步骤分开，不混在一起看
    const errAtStart = consoleErrors.length;
    // 前序步骤攒了一堆标签，先逐个点 × 关干净——顺带验证「关到最后一个」不再卡住
    await openBookByFormat(win, 'TXT', ['txt', 'text']);
    await waitFor(win, '.reader', 10000, '阅读器外壳');
    await sleep(1800);
    const atEntry = await count(win, '.reader-tab');

    let single = null;
    let closed = 0;
    const closeLog = [];
    while (closed < 15) {
      const n = await count(win, '.reader-tab');
      if (!n) break;
      // 只剩一个时先取证：标签栏与 × 是否都还在（旧实现在这里两者都没有）
      if (n === 1 && !single) {
        single = JSON.parse(await js(win, `(() => {
          const tab = document.querySelector('.reader-tab.active') || document.querySelector('.reader-tab');
          const btn = tab && tab.querySelector('.reader-tab-close');
          return JSON.stringify({
            wrap: !!document.querySelector('.reader-tabs-wrap'),
            close: !!btn,
            title: ((tab && tab.querySelector('.reader-tab-title')) || {}).textContent || '',
          });
        })()`));
        await shot(win, 'tabs-single');
      }
      // 记下「关哪一本时报了什么」：这条 ResizeObserver 警告得能指认到具体一步，
      // 否则下次核验又得从头怀疑一遍
      const who = await js(win, `((document.querySelector('.reader-tab.active .reader-tab-title') || {}).textContent || '').trim()`);
      const errBeforeClick = consoleErrors.length;
      await click(win, '.reader-tab.active .reader-tab-close');
      await sleep(700);
      if (consoleErrors.length > errBeforeClick) {
        closeLog.push(`关「${who}」（第 ${closed + 1} 个）：${consoleErrors[errBeforeClick]}`);
      }
      closed++;
    }
    const afterAll = JSON.parse(await js(win, `JSON.stringify({
      back: !!document.querySelector('.book-list'),
      tabs: document.querySelectorAll('.reader-tab').length,
    })`));

    // 对照段：同样「开 EPUB → 很快关掉」，但走改动前就有的 × 路径。
    // 用来分辨这一类 epub.js 报错是 Ctrl+W 引入的，还是 closeTab 本来就有
    const errX = consoleErrors.length;
    await openBookByFormat(win, 'EPUB');
    await waitFor(win, '.reader', 10000, '阅读器外壳');
    await sleep(1800);
    await click(win, '.reader-tab.active .reader-tab-close');
    await sleep(3500); // 这类报错是异步延迟抛的，静置太短会把它漏到窗口外面去
    const segX = consoleErrors.slice(errX);

    // Ctrl+W 挑 EPUB：它的正文在 iframe 里，正好覆盖「焦点在正文上」这条路径。
    // 这一段必须紧接在标签清零之后，否则「单标签」这个前提不成立
    const errW = consoleErrors.length;
    const epub = await openBookByFormat(win, 'EPUB');
    await waitFor(win, '.reader', 10000, '阅读器外壳');
    await sleep(1800);
    const beforeW = await count(win, '.reader-tab');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['control'] });
    await sleep(3500);
    const segW = consoleErrors.slice(errW);
    const afterW = JSON.parse(await js(win, `JSON.stringify({
      tabs: document.querySelectorAll('.reader-tab').length,
      back: !!document.querySelector('.book-list'),
    })`));
    await shot(win, 'close-tab-ctrl-w');

    // 既有路径对照：开 EPUB 再开一本凑成 2 标签，然后用 × 关掉 EPUB。
    // 这条操作改动前后一模一样（多标签关标签一直可用），它若同样报错，
    // 就说明这类报错是既有竞态，与新加的标签栏常驻 / Ctrl+W 无关。
    // 摆在 Ctrl+W 之后：它会留下一个标签，放前头会把「单标签」前提弄坏
    const errOld = consoleErrors.length;
    await openBookByFormat(win, 'EPUB');
    await waitFor(win, '.reader', 10000, '阅读器外壳');
    await sleep(1800);
    await openBookByFormat(win, 'TXT', ['txt', 'text']);
    await waitFor(win, '.reader', 10000, '阅读器外壳');
    await sleep(1800);
    const idxEpub = await js(win, `[...document.querySelectorAll('.reader-tab-title')].findIndex(e => /验收样本|EPUB/i.test(e.textContent))`);
    await click(win, '.reader-tab', idxEpub);
    await sleep(1000);
    await click(win, '.reader-tab.active .reader-tab-close');
    await sleep(3500);
    const segOld = consoleErrors.slice(errOld);
    const oldLeft = await count(win, '.reader-tab');

    // —— 分辨实验：这条 ResizeObserver 警告出自哪条路径 ——
    // 段 1：单标签也套外壳（本次改动新增的状态）开 EPUB
    const errSeg1 = consoleErrors.length;
    await openBookByFormat(win, 'EPUB');
    await waitFor(win, '.reader', 10000, '阅读器外壳');
    await sleep(3000);
    const seg1 = consoleErrors.slice(errSeg1);
    const seg1Tabs = await count(win, '.reader-tab');

    // 段 2：多标签下反复切标签（改动前就有的路径）
    const errSeg2 = consoleErrors.length;
    await openBookByFormat(win, 'TXT', ['txt', 'text']);
    await waitFor(win, '.reader', 10000, '阅读器外壳');
    await sleep(1500);
    const seg2Tabs = await count(win, '.reader-tab');
    for (let i = 0; i < seg2Tabs; i++) {
      await click(win, '.reader-tab', i);
      await sleep(700);
    }
    await sleep(1200);
    const seg2 = consoleErrors.slice(errSeg2);

    let verdict = '全部通过';
    if (afterAll.tabs !== 0) verdict = `关到最后一个卡住：仍剩 ${afterAll.tabs} 个标签`;
    else if (!afterAll.back) verdict = '标签全关后没退回书架';
    else if (!single || !single.wrap || !single.close) verdict = `单标签时没有关闭入口（标签栏:${single && single.wrap} ×:${single && single.close}）`;
    else if (beforeW !== 1) verdict = `Ctrl+W 前提不成立：已有 ${beforeW} 个标签`;
    else if (afterW.tabs !== 0 || !afterW.back) verdict = `Ctrl+W 没生效：${beforeW} → ${afterW.tabs} 标签，回书架:${afterW.back}`;
    const errAdded = consoleErrors.slice(errAtStart);
    return `${verdict}｜入口 ${atEntry} 个标签 → 点 × ${closed} 次全关 → 回书架:${afterAll.back}；`
      + `剩 1 个时 标签栏:${single && single.wrap} ×:${single && single.close}（${single && single.title}）；`
      + `Ctrl+W「${epub}」${beforeW} → ${afterW.tabs} 标签 回书架:${afterW.back}；`
      + `本步控制台错误 ${errAdded.length} 条${errAdded.length ? '：' + errAdded.join(' / ') : ''}；`
      + `分辨：单标签开 EPUB（${seg1Tabs} 个标签）${seg1.length} 条 vs 多标签切标签（${seg2Tabs} 个）${seg2.length} 条；`
      + `关闭循环内：${closeLog.length ? closeLog.join(' ｜ ') : '无'}；`
      + `× 关 EPUB（单标签）${segX.length} 条 vs Ctrl+W 关 EPUB ${segW.length} 条；`
      + `既有路径（多标签 × 关 EPUB，剩 ${oldLeft} 个）${segOld.length} 条${segOld.length ? '：' + segOld[0] : ''}`;
  });

  // ========== D22–D25. P1 收口四项 ==========
  // 这四项都不在画面上「看得见」（热键在系统层、标题在任务栏、打印在系统对话框、进程在任务管理器），
  // 所以判据不能只看截图，得从主进程侧直接取证。

  const HOTKEY_ACCEL = 'Control+Alt+H';
  await step('D22 全局热键（录制 → 注册 → 真实按键 → 清除）', async () => {
    const { globalShortcut } = require('electron');
    const { execSync } = require('child_process');
    const rowSelector = `[...document.querySelectorAll('.keymap-row')].find(r => r.textContent.includes('隐藏 / 显示窗口'))`;
    const beforeVisible = win.isVisible();

    await js(win, `document.querySelectorAll('.modal-mask').forEach(m => m.click())`);
    await clickText(win, '.nav-item', '设置');
    await sleep(1500);
    const found = await js(win, `(() => {
      const row = ${rowSelector};
      if (!row) return 'MISS';
      row.querySelector('kbd').scrollIntoView({ block: 'center' });
      return 'OK';
    })()`);
    if (found !== 'OK') return '设置页没有「全局热键」这一行';

    // 走真实入口：点键位进录制态，再派发一次带修饰键的 keydown
    await js(win, `(() => { const row = ${rowSelector}; row.querySelector('kbd').click(); })()`);
    await sleep(400);
    const recording = await js(win, `(() => { const row = ${rowSelector}; return row.querySelector('kbd').textContent.trim(); })()`);
    if (!/按下/.test(recording)) return `点了键位没进录制态，键位上显示的是「${recording}」`;

    await js(win, `(() => {
      const kbd = ${rowSelector}.querySelector('kbd');
      kbd.focus();
      kbd.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, altKey: true, bubbles: true }));
    })()`);
    await sleep(1500);
    await shot(win, 'global-hotkey');

    const registered = globalShortcut.isRegistered(HOTKEY_ACCEL);
    const stored = await js(win, `window.electronAPI.getSetting('globalHotkey')`);
    if (!registered) return `录了 Ctrl+Alt+H，但主进程没注册上（库里存的是「${stored}」）`;

    // 真按一次：全局热键的意义就是「窗口被挡住 / 收进托盘时也能响应」，
    // 只查注册状态证明不了这一点。SendKeys 从系统层把键送进去，绕过应用自身的事件链。
    const send = () =>
      execSync(`powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $w.SendKeys('^%h')"`,
        { stdio: 'ignore', timeout: 8000 });
    let real = '没测成';
    try {
      // SendKeys 发给的是「当前前台窗口」，不先把本窗口拉到前面，
      // 这一下会打进用户正开着的别的软件里
      win.show();
      win.focus();
      await sleep(600);
      send();
      await sleep(1600);
      real = win.isVisible() ? `按下后仍可见（${beforeVisible} → ${win.isVisible()}）` : '窗口已收起 ✓';
      if (!win.isVisible()) {
        send();
        await sleep(1600);
        real += win.isVisible() ? '；再按一次已唤回 ✓' : '；再按一次没唤回';
      }
    } catch (e) {
      real = `SendKeys 没跑起来：${e && e.message ? String(e.message).slice(0, 60) : e}`;
    }
    // 后面还有一长串步骤要截图，窗口无论如何得回到可见状态
    if (!win.isVisible()) { win.show(); await sleep(600); }

    await js(win, `(() => {
      const row = ${rowSelector};
      const b = [...row.querySelectorAll('button')].find(x => x.textContent.includes('清除'));
      if (b) b.click();
    })()`);
    await sleep(1200);
    const stillRegistered = globalShortcut.isRegistered(HOTKEY_ACCEL);
    const storedAfter = await js(win, `window.electronAPI.getSetting('globalHotkey')`);

    const problems = [];
    if (stillRegistered) problems.push(`${HOTKEY_ACCEL} 仍被注册着`);
    if (storedAfter) problems.push(`库里还留着「${storedAfter}」`);
    if (problems.length) return `清除没干净：${problems.join('；')}`;
    return `Ctrl+Alt+H 录制 → 已注册 ✓（库中「${stored}」）；真实按键：${real}；清除后未注册 ✓、库中为空 ✓`;
  });

  // 打印会把系统模态对话框拉起来，走查点不了它；这里被 browser-window-created 里的
  // 拦截器记下调用，验的是「应用确实发起了打印、打的是内容窗口、参数是给用户看的对话框」。
  await step('D23 应用内发起打印（唤起系统打印对话框）', async () => {
    const before = printCalls.length;
    const opened = await openBookByFormat(win, 'TXT', ['txt']);
    await waitFor(win, '.reader', 20000, '阅读器外壳');
    await sleep(1800);

    const clicked = await js(win, `(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('title') || '').startsWith('打印当前内容'));
      if (!b) return 'MISS';
      b.click();
      return 'OK';
    })()`);
    if (clicked !== 'OK') return '工具栏上没有「打印当前内容」按钮';

    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && printCalls.length === before) await sleep(300);
    await sleep(1200);
    await shot(win, 'print-direct');
    if (printCalls.length === before) return '点了打印，但没有任何打印调用发出';

    const call = printCalls[printCalls.length - 1];
    if (!/book-reader-print-\d+\.html$/.test(call.url)) return `打印的不是内容窗口，而是：${call.url}`;
    if (call.opts.silent === true) return '走的是静默打印，用户根本看不到系统对话框';
    return `「${opened}」触发打印 ✓：打印窗口 = 临时内容页，silent=${call.opts.silent}，`
      + `printBackground=${call.opts.printBackground}（系统对话框由用户确认后才会真出纸）`;
  });

  // 任务栏悬停看到的文案就是窗口标题。原先 index.html 里写死了「阅读书架」，
  // 开三本书也是三个「阅读书架」，悬停分不出谁是谁。
  await step('D24 窗口标题跟随当前书（任务栏悬停文案）', async () => {
    await goLibrary(win);
    await waitFor(win, '.book-card');
    await sleep(1200);
    const libTitle = win.getTitle();
    const opened = await openBookByFormat(win, 'TXT', ['txt']);
    await sleep(2000);
    const readerTitle = win.getTitle();
    await goLibrary(win);
    await sleep(1500);
    const backTitle = win.getTitle();

    if (readerTitle === libTitle) return `标题始终是「${readerTitle}」，没跟着书走`;
    if (backTitle !== libTitle) return `回书架后标题停在「${backTitle}」，没回到「${libTitle}」`;
    return `书架「${libTitle}」→ 打开 ${opened}「${readerTitle}」→ 回书架「${backTitle}」`;
  });

  // 「程序进程管理」这一行问的是两件事：多窗口是不是各自独立进程、关掉之后内存回不回落。
  // 两个都只能靠 app.getAppMetrics() 取证——截图上看不出来。
  await step('D25 多窗口独立进程与关闭后释放（程序进程管理取证）', async () => {
    const snap = () => {
      const list = app.getAppMetrics();
      const byType = {};
      let mb = 0;
      let renderer = 0;
      for (const m of list) {
        // 注意：Electron 把渲染进程记作 'Tab'（Chromium 内部叫法），**不是** 'renderer'——
        // 按 'renderer' 数会恒得 0，看起来像「多窗口没独立进程」的假象
        const t = String(m.type || 'Unknown');
        byType[t] = (byType[t] || 0) + 1;
        if (/^(tab|renderer)$/i.test(t)) renderer++;
        mb += (m.memory && m.memory.workingSetSize) || 0;
      }
      return { n: list.length, renderer, byType, mb: Math.round(mb / 1024) };
    };
    const fmt = s =>
      `${s.n} 进程（渲染进程 ${s.renderer}）${s.mb} MB［${Object.entries(s.byType)
        .map(([k, v]) => `${k}×${v}`)
        .join(' ')}］`;

    /** 从书架开一扇独立阅读窗口，返回它 */
    const openStandalone = async (cardIdx) => {
      await goLibrary(win);
      await waitFor(win, '.book-card');
      await click(win, '.book-card', cardIdx);
      await waitFor(win, '.btn-primary.large', 10000, '详情页「开始阅读」');
      await sleep(500);
      const before = extraWins.length;
      const r = await js(win, `(() => {
        const b = [...document.querySelectorAll('button')].find(x => /新窗口|独立窗口/.test(x.textContent));
        if (!b) return 'MISS';
        b.click();
        return 'OK';
      })()`);
      if (r !== 'OK') return null;
      await sleep(4500);
      return extraWins.length > before ? extraWins[extraWins.length - 1] : null;
    };

    const base = snap();
    const w1 = await openStandalone(0);
    const w2 = await openStandalone(1);
    await sleep(5000);
    const withWins = snap();
    await shot(win, 'proc-metrics');

    for (const w of [w1, w2]) {
      if (w && !w.isDestroyed()) w.close();
    }
    await sleep(6000);
    const after = snap();

    if (!w1 || !w2) return `没能开出两扇阅读窗口（${!!w1} / ${!!w2}），本步只能记到基线 ${fmt(base)}`;
    if (withWins.renderer <= base.renderer) {
      throw new Error(
        `开两扇阅读窗口后渲染进程没增加（${base.renderer} → ${withWins.renderer}），多窗口独立进程不成立`,
      );
    }
    const freed = withWins.mb - after.mb;
    return `书架 ${fmt(base)} → 两扇阅读窗 ${fmt(withWins)} → 全关闭 ${fmt(after)}；`
      + `每扇窗各自一个渲染进程（${base.renderer} → ${withWins.renderer} ✓）；`
      + `关窗后渲染进程回到 ${after.renderer}，${freed > 0 ? `内存回落 ${freed} MB` : '内存未回落'}`;
  });

  // 承接 D25 带出的那条既有缺陷：独立阅读窗关掉后，库里那句「我正在读这本书」的标记必须
  // 一起销账，否则下次开窗会被判成异常退出、弹一个假的「上次没有正常退出」。2026-09-19 已修。
  await step('D26 关掉独立阅读窗后不再误报「上次没有正常退出」', async () => {
    /** 从书架开一扇独立阅读窗口（走详情页「在新窗口打开」这条真实入口） */
    const openStandalone = async (cardIdx) => {
      await goLibrary(win);
      await waitFor(win, '.book-card');
      await click(win, '.book-card', cardIdx);
      await waitFor(win, '.btn-primary.large', 10000, '详情页「开始阅读」');
      await sleep(500);
      const before = extraWins.length;
      const r = await js(win, `(() => {
        const b = [...document.querySelectorAll('button')].find(x => /新窗口|独立窗口/.test(x.textContent));
        if (!b) return 'MISS';
        b.click();
        return 'OK';
      })()`);
      if (r !== 'OK') return null;
      await sleep(4500);
      return extraWins.length > before ? extraWins[extraWins.length - 1] : null;
    };
    const bookOf = w => js(w, `new URLSearchParams(location.search).get('book')`);

    const promptsBefore = crashPrompts.length;
    const w1 = await openStandalone(0);
    if (!w1) return '没能打开独立阅读窗，本用例前提不成立';
    const bid1 = String(await bookOf(w1));
    if (!/^\d+$/.test(bid1)) return `独立窗地址里没带书号（拿到「${bid1}」），本用例前提不成立`;
    // 标记得真写上了，否则下面「没有误报」可能只是因为压根没触发条件
    if (!(await js(w1, `window.electronAPI.getSetting('readingSession:${bid1}')`))) {
      return '独立窗没有写会话标记，本用例前提不成立';
    }

    // ① 第一扇还开着就再开一扇（**换一本**，两扇各持各的标记，判据才不会互相串味）。
    //    这正是 D25 触发误报的场景：两扇窗先后打开、谁都没关——新窗口不能把
    //    隔壁窗口正在读的书当成崩溃现场。光靠「关窗时清标记」挡不住这一条。
    const w2 = await openStandalone(1);
    await sleep(2500);
    const whileOpen = crashPrompts.length - promptsBefore;
    if (whileOpen > 0) {
      throw new Error(
        `第一扇独立窗还开着时又开一扇，被误判成异常退出（${whileOpen} 次）：`
        + crashPrompts.slice(promptsBefore).join(' / '),
      );
    }

    // ② 关掉第一扇：标记必须一起销账，否则下次启动会把它当成崩溃残留
    if (!w1.isDestroyed()) w1.close();
    await sleep(2500);
    const leftover = await js(win, `window.electronAPI.getSetting('readingSession:${bid1}')`);
    if (leftover) {
      throw new Error(
        `关掉独立阅读窗后会话标记仍残留（readingSession:${bid1} = ${leftover}），下次启动会误报「上次没有正常退出」`,
      );
    }

    // ③ 关窗之后再开一扇：这是最初观察到误报的场景
    const w3 = await openStandalone(0);
    await sleep(3000);
    const afterClose = crashPrompts.length - promptsBefore;
    for (const w of [w2, w3]) if (w && !w.isDestroyed()) w.close();
    await sleep(1500);
    if (afterClose > 0) {
      throw new Error(
        `关窗后再开一扇，又弹出 ${afterClose} 次假的「上次没有正常退出」：`
        + crashPrompts.slice(promptsBefore).join(' / '),
      );
    }

    return `标记已写入（readingSession:${bid1}）→ 第一扇开着时再开一扇：无假提示 ✓ → `
      + `关窗后标记清空 ✓ → 关窗后再开一扇：无假提示 ✓（本步误报 0 次）`;
  });

  // D27：本模块新加的「适应高度 / 适应整页」两档。断言只看用户能感知的事实——一页到底装不装
  // 得进窗口——不去读 React state：倍数被夹在 0.5~3 且向下取整，只有画布的实际占位能说明问题。
  await step('D27 PDF 适应宽度 / 适应高度 / 适应整页（含旋转 90° 后的宽高对调）', async () => {
    await openBookByFormat(win, 'PDF');
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await waitFor(win, '.pdf-page canvas', 20000, 'PDF 画布');
    await sleep(2500);

    /** 可用区 = 滚动容器的内容盒（它的 padding 就是页边距）；画布占位取 boundingRect */
    const geo = () => js(win, `(() => {
      const wrap = document.querySelector('.pdf-page');
      const cv = wrap && wrap.querySelector('canvas');
      if (!wrap || !cv) return null;
      const cs = getComputedStyle(wrap);
      const r = cv.getBoundingClientRect();
      return {
        availW: wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        availH: wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
        cvW: Math.round(r.width),
        cvH: Math.round(r.height),
      };
    })()`);

    // 下界取 0.94 而非 0.99：贴边误差本身很小（倍数按千分位向下取整），留出的余量是给
    // 纵向滚动条的出现/消失——它一次能让 clientWidth 变动十几像素
    const filled = (len, avail) => len >= avail * 0.94 && len <= avail + 2;
    const fits = g => g.cvW <= g.availW + 2 && g.cvH <= g.availH + 2;

    // 每个按钮点两次：第一次可能赶上滚动条出现/消失改变可用宽度，第二次用的是稳定后的布局；
    // 顺带也验证了这两档是幂等的（再点一次不会越缩越小）
    const fit = async title => {
      await click(win, `[title="${title}"]`);
      await sleep(900);
      await click(win, `[title="${title}"]`);
      await sleep(1200);
    };

    await fit('适应宽度');
    const byW = await geo();
    if (!byW) throw new Error('量不到 PDF 画布尺寸');
    if (!filled(byW.cvW, byW.availW)) {
      throw new Error(`适应宽度后画布宽 ${byW.cvW} 没贴合可用宽 ${Math.round(byW.availW)}`);
    }
    // 记下「适应宽度下这一页纵向溢不溢出」——它是后一步该不该有变化的前提
    const overflowedAtFitWidth = byW.cvH > byW.availH + 2;

    await fit('适应高度');
    const byH = await geo();
    if (byH.cvH > byH.availH + 2) {
      throw new Error(`适应高度后画布高 ${byH.cvH} 仍超出可用高 ${Math.round(byH.availH)}`);
    }
    if (overflowedAtFitWidth && !filled(byH.cvH, byH.availH) && !filled(byH.cvW, byH.availW)) {
      throw new Error(
        `适应宽度下已纵向溢出，适应高度却没把整页收进视口：画布 ${byH.cvW}x${byH.cvH}，`
        + `可用 ${Math.round(byH.availW)}x${Math.round(byH.availH)}`,
      );
    }
    await shot(win, 'pdf-fit-height');

    await fit('适应整页');
    const byPage = await geo();
    if (!fits(byPage)) {
      throw new Error(
        `适应整页后仍越界：画布 ${byPage.cvW}x${byPage.cvH}，`
        + `可用 ${Math.round(byPage.availW)}x${Math.round(byPage.availH)}`,
      );
    }
    if (!filled(byPage.cvW, byPage.availW) && !filled(byPage.cvH, byPage.availH)) {
      throw new Error(`适应整页后两边都没贴边（缩得比需要的更小）：画布 ${byPage.cvW}x${byPage.cvH}`);
    }
    await shot(win, 'pdf-fit-page');

    // 转 90° 后 pdfjs 会把页面宽高对调，基准也得跟着对调。漏了对调，算出来的倍数会偏小，
    // 表现是「整页」之后四周留一大圈白——所以转过之后仍要求至少一边贴边。
    await click(win, '[title="顺时针旋转 90°"]');
    await sleep(1500);
    await fit('适应整页');
    const rot = await geo();
    if (!fits(rot)) {
      throw new Error(
        `转 90° 后适应整页越界：画布 ${rot.cvW}x${rot.cvH}，`
        + `可用 ${Math.round(rot.availW)}x${Math.round(rot.availH)}`,
      );
    }
    if (!filled(rot.cvW, rot.availW) && !filled(rot.cvH, rot.availH)) {
      throw new Error(`转 90° 后适应整页两边都没贴边（宽高对调没生效）：画布 ${rot.cvW}x${rot.cvH}`);
    }
    await shot(win, 'pdf-fit-page-rotated');

    // 转回 0°，别把旋转状态留给后面的步骤
    for (let i = 0; i < 3; i++) {
      await click(win, '[title="顺时针旋转 90°"]');
      await sleep(400);
    }
    await sleep(800);

    return `可用 ${Math.round(byW.availW)}x${Math.round(byW.availH)}：适应宽度 ${byW.cvW}x${byW.cvH} → `
      + `适应高度 ${byH.cvW}x${byH.cvH} → 适应整页 ${byPage.cvW}x${byPage.cvH} → `
      + `转 90° 后整页 ${rot.cvW}x${rot.cvH}，四档均未越界且贴边 ✓`;
  });

  // D28：文件信息补「页数 / 文档权限」——本轮为 V1.0 差距清单第 7 条做的。
  // 两处界面都要核：书籍详情页「信息」标签、书架右键「属性」弹窗。
  // 页数只有 PDF 有固定含义（TXT 取决于字号、EPUB 走 CFI、漫画数是图片张数），
  // 所以非 PDF 必须落到「—」——填个会变的数字比不填更糟。
  await step('D28 文件信息补页数与权限（详情页 + 右键属性，PDF 与 TXT 各核一遍）', async () => {
    /** 打开某格式书的详情页（不点「开始阅读」），返回书名 */
    const openDetailOf = async fmt => {
      await goLibrary(win);
      await waitFor(win, '.book-card');
      const cards = await js(win, `[...document.querySelectorAll('.book-card')].map(c => ({
        t: (c.querySelector('.book-title') || {}).textContent?.trim() || '',
        f: ((c.querySelector('.cover-foot') || {}).textContent || '').trim().toUpperCase(),
      }))`);
      const idx = cards.findIndex(x => x.f === fmt.toUpperCase());
      if (idx < 0) throw new Error(`书架上找不到 ${fmt} 的书，现有：${cards.map(x => x.f).join('/')}`);
      await click(win, '.book-card', idx);
      await waitFor(win, '.btn-primary.large', 10000, `${fmt} 详情页`);
      await sleep(600);
      return cards[idx].t;
    };

    /** 读详情页「信息」标签里新加的两行 */
    const readInfoRows = async () => {
      await clickText(win, '.tab, .detail-tab', '信息', true);
      await sleep(800);
      return js(win, `(() => {
        const rows = [...document.querySelectorAll('.info-row')];
        const get = k => {
          const r = rows.find(x => ((x.querySelector('span') || {}).textContent || '').trim() === k);
          const spans = r ? r.querySelectorAll('span') : [];
          return spans[1] ? spans[1].textContent.trim() : null;
        };
        return { pages: get('页数'), perm: get('权限') };
      })()`);
    };

    await openDetailOf('PDF');
    const pdfInfo = await readInfoRows();
    await shot(win, 'detail-info-pdf');
    // 固件 PDF 共 5 页（同轮 D15 的「1 / 5 → 5 / 5」可佐证），且由 pdf-lib 生成、没有加密字典
    if (pdfInfo.pages !== '5 页') throw new Error(`PDF 页数应为「5 页」，实得「${pdfInfo.pages}」`);
    if (pdfInfo.perm !== '无限制') throw new Error(`未加密 PDF 的权限应为「无限制」，实得「${pdfInfo.perm}」`);

    await openDetailOf('TXT');
    const txtInfo = await readInfoRows();
    await shot(win, 'detail-info-txt');
    if (txtInfo.pages !== '—' || txtInfo.perm !== '—') {
      throw new Error(`TXT 的页数/权限应为「—/—」，实得「${txtInfo.pages}/${txtInfo.perm}」`);
    }

    // 右键「属性」走的是渲染层的 window.alert：真弹出来会挡住渲染层，executeJavaScript 不返回、
    // 走查当场卡死，所以先换成记账版，读完再把原生的还回去
    await js(win, `(() => {
      window.__origAlert = window.alert;
      window.__alerts = [];
      window.alert = m => window.__alerts.push(String(m));
    })()`);
    await goLibrary(win);
    await waitFor(win, '.book-card');
    const box = await js(win, `(() => {
      const cards = [...document.querySelectorAll('.book-card')];
      const i = cards.findIndex(c => ((c.querySelector('.cover-foot') || {}).textContent || '').trim().toUpperCase() === 'PDF');
      if (i < 0) return null;
      const r = cards[i].getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!box) throw new Error('书架上找不到 PDF 卡片');
    // 从输入层注入真实右键：合成 contextmenu 事件有时收不到（同 B3 的说明）
    win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'right', clickCount: 1 });
    await sleep(900);
    await clickText(win, '.context-menu-item', '属性', true);
    let alertText = '';
    for (let i = 0; i < 25 && !alertText; i++) {
      const list = await js(win, `window.__alerts || []`);
      if (list.length) alertText = list[list.length - 1];
      else await sleep(200);
    }
    await js(win, `(() => { if (window.__origAlert) window.alert = window.__origAlert; })()`);
    await shot(win, 'library-attr-pdf');
    if (!alertText) throw new Error('点了「属性」但没等到弹窗文案');
    const flat = alertText.replace(/\n/g, ' / ');
    if (!alertText.includes('页数：5 页') || !alertText.includes('权限：无限制')) {
      throw new Error(`属性弹窗里缺页数或权限：${flat}`);
    }

    return `详情页 PDF ${pdfInfo.pages}／${pdfInfo.perm}、TXT ${txtInfo.pages}／${txtInfo.perm}；`
      + `右键属性 PDF 弹窗「页数：5 页」「权限：无限制」✓`;
  });

  // D29：书架「最近打开」列表——本轮为 V1.0 差距清单第 4 条补的。
  // 它和上面那张「继续阅读」卡片是两件事：那张只挑未读完的一本，这条按最后打开时间列最近 6 本。
  await step('D29 书架「最近打开」列表（内容与顺序对齐库里的 last_read_at）', async () => {
    await goLibrary(win);
    await waitFor(win, '.book-card');
    await sleep(600);

    // 不写死期望值，直接拿库里同一份数据算一遍预期顺序再比——写死「应该有 6 条」验不出顺序错
    const listed = await js(win, `(async () => {
      const shown = [...document.querySelectorAll('.recent-item')].map(e => ({
        t: (e.querySelector('.recent-title') || {}).textContent?.trim() || '',
        m: (e.querySelector('.recent-meta') || {}).textContent?.trim() || '',
      }));
      const books = await window.electronAPI.getAllBooks();
      const want = books
        .filter(b => b.last_read_at)
        .sort((a, b) => String(b.last_read_at).localeCompare(String(a.last_read_at)))
        .slice(0, 6)
        .map(b => b.title);
      const head = document.querySelector('.recent-head');
      return { shown, want, head: head ? head.textContent.trim() : null };
    })()`);

    if (!listed.shown.length) throw new Error('书架上没有渲染出「最近打开」');
    if (listed.head !== '最近打开') throw new Error(`标题应为「最近打开」，实得「${listed.head}」`);
    const got = listed.shown.map(x => x.t);
    if (got.join('｜') !== listed.want.join('｜')) {
      throw new Error(`最近打开的顺序与库里对不上：页面 [${got.join(' / ')}]，预期 [${listed.want.join(' / ')}]`);
    }
    if (listed.shown.some(x => !x.m)) throw new Error('有条目没渲染出「进度 · 时间」那一行');

    await shot(win, 'library-recent');

    // 真点一下第一条：它应当直接进阅读器（与「继续阅读」同一个入口）
    await click(win, '.recent-item', 0);
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await sleep(1500);
    await shot(win, 'library-recent-opened');

    // Esc 无面板时返回书架——不把「正在阅读」的状态留给后面的步骤
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(1500);
    if (!(await js(win, `!!document.querySelector('.book-card')`))) {
      throw new Error('从「最近打开」进的阅读器按 Esc 没回到书架');
    }

    return `最近打开 ${got.length} 条，顺序与库里 last_read_at 一致 ✓（首条「${got[0]}」→ ${listed.shown[0].m}）；`
      + `点首条进阅读器 ✓，Esc 回书架 ✓`;
  });

  // 命中导航：上一处 / 下一处。验的是「连续翻找不用重开面板」——点结果本身早就能跳（D12），
  // 缺的是跳完面板就关、想看下一处只能重开面板重搜。所以本步的关键断言是**每次点完面板还在**。
  await step('D30 检索命中的上一处 / 下一处（连续翻找不关面板）', async () => {
    await openBookByFormat(win, 'EPUB');
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await sleep(2500);
    await click(win, '[title="书内检索"]');
    await sleep(1200);
    // 与 D12 同一套写法：React 受控输入必须走原生 setter，否则 onChange 收不到
    await js(win, `(() => {
      const inp = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('关键词'));
      if (!inp) return 'NOINPUT';
      inp.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '正文');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      return 'OK';
    })()`);
    await sleep(2500);

    const snap = () => js(win, `(() => {
      const ind = document.querySelector('.page-indicator.wide');
      return {
        count: ((document.querySelector('.search-count') || {}).textContent || '').trim(),
        chapter: ind ? ind.textContent.trim() : '',
        active: document.querySelectorAll('.mark-item.search-hit.active').length,
        activeLabel: ((document.querySelector('.mark-item.search-hit.active .mark-label') || {}).textContent || '').trim(),
        panel: !!document.querySelector('.toc-panel'),
        buttons: [...document.querySelectorAll('.search-nav-btns button')].map(b => b.textContent.trim()),
      };
    })()`);

    const before = await snap();
    if (!before.panel) throw new Error('检索面板没打开');
    if (before.buttons.length !== 2) throw new Error(`未渲染出两个导航按钮，实得 ${JSON.stringify(before.buttons)}`);
    const m = before.count.match(/共找到 (\d+) 处/);
    if (!m) throw new Error(`未渲染出命中计数，实得「${before.count}」`);
    const total = Number(m[1]);
    // sample.epub 三章各含「正文」→ 3 处；少于 3 处验不出往返（绕回那一跳就没了）
    if (total < 3) throw new Error(`命中只有 ${total} 处，验不出往返，本步需要至少 3 处`);

    const press = async (label) => {
      const ok = await js(win, `(() => {
        const b = [...document.querySelectorAll('.search-nav-btns button')].find(x => x.textContent.includes('${label}'));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!ok) throw new Error(`找不到「${label}」按钮`);
      await sleep(1800);
      return snap();
    };

    // 下一处 → 下一处 → 下一处（末尾绕回第一处）→ 上一处（第一处绕回最后一处）
    const seq = [
      ['下一处', 1], ['下一处', 2], ['下一处', 3], ['下一处', 1], ['上一处', total],
    ];
    const walked = [];
    for (const [label, want] of seq) {
      const s = await press(label);
      if (!s.panel) throw new Error(`按「${label}」后面板被关掉了——连续翻找会断在这里`);
      if (s.active !== 1) throw new Error(`当前命中项应有且只有 1 条带 active，实得 ${s.active}`);
      const expect = `第 ${want} / ${total} 处`;
      if (!s.count.includes(expect)) throw new Error(`按「${label}」后应停在第 ${want} 处，面板写的是「${s.count}」`);
      walked.push(`${label}→${expect}（${s.activeLabel || '无标签'}｜${s.chapter}）`);
      // 章节坐标真的动了，才说明跳转发生了、不是只改了个计数
      if (label !== '上一处' && want <= 3 && !s.chapter.includes(`第${want}章`)) {
        throw new Error(`按「${label}」后应到第 ${want} 章，底部写的是「${s.chapter}」`);
      }
    }

    await shot(win, 'reader-search-nav');

    // 点列表里的结果仍然照旧收面板（步进是新加的旁路，不该改变原有交互）
    await js(win, `(() => { const el = document.querySelector('.mark-item.search-hit'); if (el) el.click(); })()`);
    await sleep(1500);
    const afterClick = await js(win, `!!document.querySelector('.toc-panel')`);
    if (afterClick) throw new Error('点击命中结果后面板没收起来——原有交互被步进改掉了');

    return `共 ${total} 处：${walked.join(' → ')}；结果点击仍收面板 ✓`;
  });

  // 窗口级拖拽：本轮为 P0 半成项「文件拖拽打开」收口。
  // 要验的是两件相反的事，所以必须都在同一步里：① 书架以外拖 = 直接打开阅读；
  // ② 书架上拖 = 仍是「导入书库」（窗口那层要认 defaultPrevented 让路，不能一次拖放走两条路径）。
  await step('D31 窗口级拖拽：书架以外拖 = 直接打开，书架上拖 = 导入', async () => {
    // 拖进来的那本书挑「库里已有」的：那样走的是「已在库中就直接读」分支，
    // 打开后标签页会切到它的书名——「有没有真的打开」才有可观测的判据。
    // 路径直接取库里的原值来拖（而不是自己拼一份）：handleOpenPath 是按字符串全等找书的，
    // 自己拼的那份只要和入库时的写法差一个斜杠，就会滑到「先导入」分支，验的就不是这条路径了。
    const dropped = await js(win, `(async () => {
      const list = await window.electronAPI.getAllBooks();
      const b = list.find(x => /sample\\.txt$/i.test(x.file_path));
      return b ? { path: b.file_path, title: b.title } : null;
    })()`);
    if (!dropped) throw new Error('库里找不到 sample.txt，本步需要一本已在库中的书');
    const wantTitle = dropped.title;

    // 先停在另一本书上（EPUB），否则「打开的书换没换」根本看不出来
    const before = await openBookByFormat(win, 'EPUB');
    await waitFor(win, '.reader', 15000, '阅读器外壳');
    await sleep(2000);

    // 拖放本身在页面里手搓 DragEvent，但**放进去的 File 必须是真的**——
    // webUtils.getPathForFile 只认真实文件支撑的 File，对 new File() 一律返回空串，
    // 而 contextBridge 暴露的 electronAPI 不可重定义，那个口子想换也换不掉
    // （实测 defineProperty 直接抛 Cannot redefine property）。
    // 所以借 CDP 的 DOM.setFileInputFiles 往一个隐藏 input 里塞进指定路径的真 File，
    // 再把它放进 DataTransfer：事件是手搓的，交到产品代码手里的东西跟真拖放一模一样。
    // （顺带也试过 CDP 的 Input.dispatchDragEvent，那条在 Electron 里一条事件都到不了页面，弃用。）
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    const probeInput = await dbg.sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const i = document.createElement('input');
        i.type = 'file'; i.id = '__walkFileProbe'; i.style.display = 'none';
        document.body.appendChild(i);
        return i;
      })()`,
    });
    await dbg.sendCommand('DOM.setFileInputFiles', {
      files: [dropped.path],
      objectId: probeInput.result.objectId,
    });
    // 取出来先自己核一遍：路径对不上就说明这套喂法不成立，那后面的断言全无意义
    const realFile = await js(win, `(() => {
      const i = document.getElementById('__walkFileProbe');
      const f = i && i.files && i.files[0];
      window.__walkDragFile = f || null;
      const out = f ? { name: f.name, size: f.size, path: window.electronAPI.getPathForFile(f) } : null;
      if (i) i.remove();
      return out;
    })()`);
    if (!realFile || realFile.path !== dropped.path) {
      throw new Error(`没能把真实文件喂进拖放：${JSON.stringify(realFile)}（期望路径 ${dropped.path}）`);
    }

    // 真 alert 会阻塞渲染层，executeJavaScript 会一直等下去，所以换成计数器。
    // 它同时也是本步的一条证据：书架那条路「已在库中」时会弹「未导入」，窗口那条路不该弹。
    // 原函数留着，本步结束时放回去——不把全走查的 alert 都换掉。
    await js(win, `(() => {
      window.__alerts = [];
      window.__realAlert = window.alert;
      window.alert = m => window.__alerts.push(String(m));
    })()`);

    const overlays = () => js(win, `[...document.querySelectorAll('.drop-overlay')].map(e => e.textContent.trim())`);

    // 诊断埋点：把窗口上看到的 dragover / drop 录下来（捕获与冒泡各一份）。
    // 这条链路跨 DOM → React 委托 → window 监听，失败时只看「没出现遮罩」判断不出断在哪：
    // 事件没到（DOM 层）、types 里没有 'Files'（数据层）、还是监听压根没挂上（顺序层）。
    await js(win, `(() => {
      window.__dragSeen = [];
      for (const capture of [true, false]) {
        for (const t of ['dragover', 'drop']) {
          window.addEventListener(t, e => window.__dragSeen.push({
            t, capture,
            types: e.dataTransfer ? [...e.dataTransfer.types] : null,
            files: e.dataTransfer ? e.dataTransfer.files.length : null,
            prevented: e.defaultPrevented,
            target: String(e.target.className || e.target.tagName).slice(0, 30),
          }), capture);
        }
      }
    })()`);
    const dragSeen = () => js(win, `window.__dragSeen.slice()`);

    /** 起一次拖放（dragenter + dragover），返回 dataTransfer.types 备查。分开"起"和"落"两步才能读拖着的中间态 */
    const beginDrag = sel => js(win, `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el || !window.__walkDragFile) return 'NOEL';
      const dt = new DataTransfer();
      dt.items.add(window.__walkDragFile);
      window.__walkDT = dt;
      const mk = t => new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt });
      el.dispatchEvent(mk('dragenter'));
      el.dispatchEvent(mk('dragover'));
      return [...dt.types].join(',');
    })()`);
    const dropOn = sel => js(win, `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el || !window.__walkDT) return 'NOEL';
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__walkDT }));
      return 'OK';
    })()`);

    try {
      // ---- ① 阅读页（书架以外）拖进来：语义应当是「直接打开阅读」 ----
      const midTypes = await beginDrag('.main-content');
      if (midTypes === 'NOEL') throw new Error('页面上找不到 .main-content');
      await sleep(600);
      const midOverlays = await overlays();
      if (midOverlays.length !== 1) {
        throw new Error(`阅读页拖入时应恰好显示一层遮罩，实得 ${midOverlays.length} 层：${JSON.stringify(midOverlays)}`
          + `（dataTransfer.types=${midTypes}；窗口上看到的事件：${JSON.stringify(await dragSeen())}）`);
      }
      if (!midOverlays[0].includes('松开直接打开')) {
        throw new Error(`阅读页拖入的遮罩文案不对：「${midOverlays[0]}」`);
      }
      await shot(win, 'drag-window-overlay');

      if (await dropOn('.main-content') !== 'OK') throw new Error('松手事件派发失败');
      await sleep(3000);

      // 落点没人接的话，Chromium 会把整页导航到 file:// 上，界面直接白掉。
      // 这条比后面的断言都要紧，先查。
      if (!(await js(win, `!!document.querySelector('.app')`))) {
        throw new Error('松手后整页被导航走了（页面已不是应用本体）——仍有 drag 监听没止住默认行为');
      }
      if ((await overlays()).length !== 0) throw new Error('松手后遮罩没收起来');
      const afterTab = await js(win, `(() => {
        const t = document.querySelector('.reader-tab.active .reader-tab-title');
        return t ? t.textContent.trim() : null;
      })()`);
      if (afterTab !== wantTitle) {
        throw new Error(`松手后应切到《${wantTitle}》，当前标签是「${afterTab}」`);
      }
      const alertsA = await js(win, `window.__alerts.slice()`);
      if (alertsA.length) throw new Error(`已在库中的书不该有任何弹窗，实得：${JSON.stringify(alertsA)}`);

      // ---- ② 书架上拖进来：应当仍是「导入书库」，窗口那层靠 defaultPrevented 让路 ----
      await goLibrary(win);
      await waitFor(win, '.book-card');
      await js(win, `window.__alerts = []`);
      const shelfTypes = await beginDrag('.book-list');
      if (shelfTypes === 'NOEL') throw new Error('页面上找不到 .book-list');
      await sleep(600);
      const shelfOverlays = await overlays();
      // 两处都亮遮罩就是"一次拖放走了两条路径"的直接证据，所以这里要卡死层数
      if (shelfOverlays.length !== 1) {
        throw new Error(`书架上拖入时应只有书架自己那一层遮罩，实得 ${shelfOverlays.length} 层：${JSON.stringify(shelfOverlays)}`);
      }
      if (!shelfOverlays[0].includes('松开导入')) {
        throw new Error(`书架上拖入的遮罩文案不对（说明被窗口那层顶掉了）：「${shelfOverlays[0]}」`);
      }
      await shot(win, 'drag-shelf-overlay');

      await dropOn('.book-list');
      await sleep(3000);

      // 书架的语义是「导入」：停在书架上，不该跳到阅读器
      if (!(await js(win, `!!document.querySelector('.book-card')`))) {
        throw new Error('书架上拖入后离开了书架——窗口那层把这次拖放也当成「直接打开」处理了');
      }
      const alertsB = await js(win, `window.__alerts.slice()`);
      // 这本已在库里，导入必然被拦下并弹窗说明——弹窗出现本身就是「走的是书架那条导入路」的凭证
      if (!alertsB.some(m => /未导入/.test(m))) {
        throw new Error(`书架上拖入应走导入并说明未导入原因，实得弹窗：${JSON.stringify(alertsB)}`);
      }

      return `阅读页拖入：遮罩「${midOverlays[0]}」→ 松手切到《${afterTab}》、页面未被导航走、无弹窗 ✓；`
        + `书架上拖入：仍有且只有书架遮罩「${shelfOverlays[0]}」→ 留在书架 ✓（导入提示「${alertsB[0].replace(/\s+/g, ' ').slice(0, 40)}…」）；`
        + `拖的 File 是真文件（${realFile.name} ${realFile.size}B，getPathForFile 返回路径 ✓，dataTransfer.types=${midTypes}）；起点 ${before}`;
    } finally {
      if (dbg.isAttached()) dbg.detach();
      await js(win, `(() => { if (window.__realAlert) window.alert = window.__realAlert; })()`).catch(() => {});
    }
  });

  // ========== E. 侧栏各页 ==========
  const navPages = ['生词本', '我的笔记', '统计', '语义检索', '文档比较', 'PDF 工具', '本地模型', '帮助与关于'];
  for (const label of navPages) {
    await step(`E 侧栏页「${label}」`, async () => {
      await js(win, `document.querySelectorAll('.modal-mask').forEach(m => m.click())`);
      await sleep(300);
      await clickText(win, '.nav-item', label);
      // 「本地模型」页要先探测引擎与模型文件，给足时间；其余页 1.6s 足够
      await sleep(label === '本地模型' ? 5000 : 1600);
      await shot(win, `nav-${label}`);
    });
  }

  await step('E 设置页（滚动 3 屏）', async () => {
    await clickText(win, '.nav-item', '设置');
    await sleep(1500);
    await shotScroll(win, 'settings', 3);
  });

  await step('E 主题切换（深/浅）', async () => {
    const themes = await js(win, `[...document.querySelectorAll('button')].filter(b => /深色|浅色|跟随系统|主题/.test(b.textContent)).map(b => b.textContent.trim()).slice(0, 6)`);
    if (!themes.length) return '设置页里没找到主题按钮';
    return `可选：${themes.join('/')}`;
  });

  // ========== F. 独立阅读器窗口 ==========
  await step('F 详情页「在新窗口打开阅读器」', async () => {
    const before = extraWins.length;
    await goLibrary(win);
    await click(win, '.book-card', 0);
    await waitFor(win, '.btn-primary.large', 10000, '详情页');
    await sleep(500);
    const opened = await js(win, `(() => {
      const b = [...document.querySelectorAll('button')].find(x => /新窗口|独立窗口/.test(x.textContent));
      if (!b) return 'MISS';
      b.click(); return 'OK';
    })()`);
    if (opened !== 'OK') return '详情页没有「新窗口」按钮';
    await sleep(4000);
    if (extraWins.length === before) return '点了但没建新窗口';
    const w = extraWins[extraWins.length - 1];
    if (w.webContents.isLoading()) await new Promise(r => w.webContents.once('did-finish-load', r));
    await sleep(5000);
    if (!w.isVisible()) w.showInactive();
    await sleep(1000);
    await shot(w, 'reader-standalone-window');
    return `新窗口标题「${w.getTitle()}」，尺寸 ${JSON.stringify(w.getSize())}`;
  });

  // ========== 收尾：真实重载一次，看有没有启动即报错 ==========
  await step('G 重载渲染层看是否干净启动', async () => {
    const before = consoleErrors.length;
    await win.webContents.reload();
    await sleep(4000);
    const added = consoleErrors.length - before;
    return added ? `重载后新增 ${added} 条控制台错误` : '重载无新的控制台错误';
  });
}

app.whenReady().then(async () => {
  let fatal = null;
  try {
    await run();
  } catch (e) {
    fatal = e && e.stack ? e.stack : String(e);
    log(`!! 走查中断：${fatal}`);
    try { if (mainWin) await shot(mainWin, 'fatal'); } catch { /* 截图失败就算了 */ }
  }

  const report = {
    finishedAt: new Date().toISOString(),
    shots: fs.readdirSync(SHOTS),
    steps,
    consoleErrors,
    fatal,
  };
  fs.writeFileSync(path.join(__dirname, 'ui-walk-report.json'), JSON.stringify(report, null, 2));

  log(`—— 走查结束：截图 ${report.shots.length} 张，控制台错误 ${consoleErrors.length} 条${fatal ? '，有中断' : ''}`);
  if (consoleErrors.length) consoleErrors.slice(0, 20).forEach(e => log(`   console.error: ${e}`));

  setTimeout(() => app.exit(fatal ? 1 : 0), 500);
});

// 主进程未捕获异常也记下来（走查就是要看这些）
process.on('uncaughtException', e => log(`!! 主进程未捕获异常：${e && e.stack ? e.stack : e}`));

// 最后才 require 主进程 bundle：它顶层就调用 protocol.registerSchemesAsPrivileged，
// 必须在 app ready 之前跑；而沙箱路径又必须在它之前设好，所以顺序是 沙箱 → 监听 → require。
// 此处仍处于同步阶段，app 尚未 ready，时序正确。
require(path.join(ROOT, 'dist-electron', 'main.js'));
