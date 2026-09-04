import ePub from 'epubjs';

export class EpubReader {
  private book: any;
  private rendition: any;

  async load(filePath: string, container: HTMLElement) {
    this.book = ePub(filePath);
    this.rendition = this.book.renderTo(container, {
      width: '100%',
      height: '100%',
      spread: 'none',
    });
    this.rendition.display();
    return this;
  }

  goNext() {
    this.rendition?.next();
  }

  goPrev() {
    this.rendition?.prev();
  }

  goTo(href: string) {
    this.rendition?.display(href);
  }

  async getCover() {
    return this.book?.coverUrl();
  }

  async getMetadata() {
    return this.book?.loaded.metadata;
  }

  onStateChanged(callback: (state: any) => void) {
    this.rendition?.on('relocated', callback);
  }

  destroy() {
    this.book?.destroy();
  }
}
