import * as pdfjsLib from 'pdfjs-dist';

// 设置 worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

export class PdfReader {
  private pdfDoc: any = null;
  private currentPage = 1;
  private totalPages = 0;

  async load(filePath: string) {
    const fs = await import('fs');
    const buffer = fs.readFileSync(filePath);
    const data = new Uint8Array(buffer);
    this.pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    this.totalPages = this.pdfDoc.numPages;
    this.currentPage = 1;
    return this;
  }

  async renderPage(pageNum: number, canvas: HTMLCanvasElement) {
    if (!this.pdfDoc) return;
    const page = await this.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, viewport }).promise;
    this.currentPage = pageNum;
  }

  async renderCurrentPage(canvas: HTMLCanvasElement) {
    await this.renderPage(this.currentPage, canvas);
  }

  goNext(canvas: HTMLCanvasElement) {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
      this.renderCurrentPage(canvas);
    }
  }

  goPrev(canvas: HTMLCanvasElement) {
    if (this.currentPage > 1) {
      this.currentPage--;
      this.renderCurrentPage(canvas);
    }
  }

  getProgress(): number {
    return this.totalPages > 0 ? this.currentPage / this.totalPages : 0;
  }

  getPageCount(): number {
    return this.totalPages;
  }

  destroy() {
    this.pdfDoc?.destroy();
  }
}
