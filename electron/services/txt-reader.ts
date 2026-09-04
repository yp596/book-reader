import fs from 'fs';

export class TxtReader {
  private content: string = '';
  private lines: string[] = [];
  private currentPage = 0;
  private pageSize = 100; // 每页显示行数

  async load(filePath: string) {
    const buffer = fs.readFileSync(filePath);
    // 尝试 UTF-8，失败则用 latin1（兼容各种编码）
    try {
      this.content = buffer.toString('utf-8');
    } catch {
      this.content = buffer.toString('latin1');
    }
    this.lines = this.content.split('\n');
    this.currentPage = 0;
    return this;
  }

  getCurrentPage(): string {
    const start = this.currentPage * this.pageSize;
    const end = start + this.pageSize;
    return this.lines.slice(start, end).join('\n');
  }

  goNext(): boolean {
    if (this.currentPage < this.getTotalPages() - 1) {
      this.currentPage++;
      return true;
    }
    return false;
  }

  goPrev(): boolean {
    if (this.currentPage > 0) {
      this.currentPage--;
      return true;
    }
    return false;
  }

  getTotalPages(): number {
    return Math.ceil(this.lines.length / this.pageSize);
  }

  getProgress(): number {
    const total = this.getTotalPages();
    return total > 0 ? (this.currentPage + 1) / total : 0;
  }

  getFullText(): string {
    return this.content;
  }

  destroy() {
    this.content = '';
    this.lines = [];
  }
}
